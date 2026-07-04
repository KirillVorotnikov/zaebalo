import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { configManager } from './configManager.js';

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

function getFeynmanSettings() {
  return configManager.settings?.feynman ?? {};
}

function getFeynmanRoot() {
  const relative = getFeynmanSettings().root ?? '../feynman';
  return path.resolve(configManager.getProjectRoot(), relative);
}

function getFeynmanBinPath() {
  return path.join(getFeynmanRoot(), 'bin', 'feynman.js');
}

function getFeynmanAgentDir() {
  const feynmanHome = path.resolve(process.env.FEYNMAN_HOME ?? os.homedir(), '.feynman');
  return path.join(feynmanHome, 'agent');
}

function getFeynmanCwd() {
  // Default cwd is the workspace root (sibling of nornikel_KG) so Feynman's bash/read/write
  // tools and the project-local ".feynman/skills/materials-hypotheses" skill are both in scope.
  const relative = getFeynmanSettings().cwd ?? '..';
  return path.resolve(configManager.getProjectRoot(), relative);
}

let trustEnsured = false;

/**
 * Feynman/Pi gate project-local resources (including our "materials-hypotheses"
 * skill under <workspaceRoot>/.feynman/skills/) behind project trust. Interactive
 * mode would prompt for this; RPC mode never prompts (see Pi's security.md) and
 * silently skips untrusted project resources instead. We pre-seed a persisted
 * trust decision via Pi's own ProjectTrustStore (same store interactive mode
 * writes to at ~/.feynman/agent/trust.json) so headless RPC sessions see the
 * skill without requiring any interactive step.
 */
async function ensureWorkspaceTrusted() {
  if (trustEnsured) return;
  try {
    const entryPath = path.join(getFeynmanRoot(), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js');
    const { ProjectTrustStore } = await import(pathToFileURL(entryPath).href);
    const store = new ProjectTrustStore(getFeynmanAgentDir());
    store.set(getFeynmanCwd(), true);
    trustEnsured = true;
  } catch (error) {
    // Best-effort: if this fails, sessions still work, just without project-local
    // skills/settings until trust is granted some other way.
    console.warn(`[feynmanBridge] could not pre-trust workspace: ${error.message}`);
  }
}

function getIdleTimeoutMs() {
  return getFeynmanSettings().idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
}

function getFeynmanModel() {
  return getFeynmanSettings().model || '';
}

function getSessionsDir() {
  return path.join(configManager.getWebRoot(), 'runtime', 'feynman-sessions');
}

/**
 * Reads JSONL (one JSON object per LF-delimited line) from a stream, per Pi's
 * RPC framing rules: split on \n only, tolerate a trailing \r, and do NOT use
 * Node's readline (it also splits on U+2028/U+2029, which can appear inside
 * JSON string values).
 */
function attachJsonlReader(stream, onLine) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';

  stream.on('data', (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      onLine(line);
    }
  });

  stream.on('end', () => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      onLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
    }
  });
}

/**
 * Wraps one long-lived `feynman --mode rpc` subprocess for a single chat
 * conversation. Emits high-level events for the API/SSE layer:
 *   - "delta"      { text }                         streamed assistant text
 *   - "tool"       { phase, toolName, toolCallId }   tool_execution_* events
 *   - "turn_end"                                     agent finished this turn
 *   - "error"      { message }                       extension errors / failed RPC responses
 *   - "log"        { level, message }                non-JSON stdout/stderr noise (e.g. npm output)
 *   - "closed"     { code }                           process exited
 */
class FeynmanSession extends EventEmitter {
  constructor(conversationId) {
    super();
    this.conversationId = conversationId;
    this.isStreaming = false;
    this.idleTimer = null;
    this.child = null;
    this.pendingRequestId = 0;
  }

  async start() {
    await ensureWorkspaceTrusted();

    const binPath = getFeynmanBinPath();
    const cwd = getFeynmanCwd();
    const sessionDir = path.join(getSessionsDir(), this.conversationId);
    mkdirSync(sessionDir, { recursive: true });

    const model = getFeynmanModel();
    const args = [binPath, '--mode', 'rpc', '--session-dir', sessionDir, '--cwd', cwd];
    if (model) args.push('--model', model);

    this.child = spawn(process.execPath, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    attachJsonlReader(this.child.stdout, (line) => this.handleLine(line));
    attachJsonlReader(this.child.stderr, (line) => {
      if (line.trim()) this.emit('log', { level: 'warn', message: line.trim() });
    });

    this.child.on('error', (error) => {
      this.emit('error', { message: `Failed to launch Feynman: ${error.message}` });
    });

    this.child.on('close', (code) => {
      this.clearIdleTimer();
      this.emit('closed', { code });
    });

    this.resetIdleTimer();
    return this;
  }

  handleLine(line) {
    if (!line.trim()) return;
    this.resetIdleTimer();

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // Non-JSON noise (e.g. npm audit output during first-run package setup).
      this.emit('log', { level: 'info', message: line.trim() });
      return;
    }

    switch (event.type) {
      case 'response': {
        if (event.success === false) {
          this.emit('error', { message: event.error ?? `${event.command} failed` });
        }
        break;
      }
      case 'agent_start': {
        this.isStreaming = true;
        break;
      }
      case 'agent_end': {
        this.isStreaming = false;
        this.emit('turn_end', {});
        break;
      }
      case 'message_update': {
        const delta = event.assistantMessageEvent;
        if (delta?.type === 'text_delta' && delta.delta) {
          this.emit('delta', { text: delta.delta });
        } else if (delta?.type === 'thinking_delta' && delta.delta) {
          this.emit('thinking', { text: delta.delta });
        } else if (delta?.type === 'error') {
          this.emit('error', { message: 'Model request failed (see server logs for details).' });
        }
        break;
      }
      case 'turn_end': {
        // A turn can "end" via agent_end with zero assistant text when the
        // provider call itself failed (e.g. quota errors) rather than producing
        // a normal refusal/response. Surface that instead of silently going idle.
        const message = event.message;
        if (message?.role === 'assistant' && message.stopReason === 'error' && (!message.content || message.content.length === 0)) {
          this.emit('error', { message: message.errorMessage ?? 'Model request failed with no response.' });
        }
        break;
      }
      case 'tool_execution_start': {
        this.emit('tool', { phase: 'start', toolName: event.toolName, toolCallId: event.toolCallId, args: event.args });
        break;
      }
      case 'tool_execution_end': {
        this.emit('tool', { phase: 'end', toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError });
        break;
      }
      case 'extension_error': {
        this.emit('log', { level: 'warn', message: `Extension error (${event.extensionPath}): ${event.error}` });
        break;
      }
      default:
        break;
    }
  }

  send(command) {
    if (!this.child || this.child.exitCode !== null) {
      throw new Error('Feynman session is not running');
    }
    this.resetIdleTimer();
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  prompt(message) {
    if (this.isStreaming) {
      // Queue as a steering message rather than rejecting outright, matching
      // Pi's documented behavior for prompts sent while a turn is in progress.
      this.send({ id: String(++this.pendingRequestId), type: 'prompt', message, streamingBehavior: 'steer' });
      return;
    }
    this.send({ id: String(++this.pendingRequestId), type: 'prompt', message });
  }

  resetIdleTimer() {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.emit('log', { level: 'info', message: 'Feynman session idle timeout reached; closing.' });
      this.stop();
    }, getIdleTimeoutMs());
    this.idleTimer.unref?.();
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  stop() {
    this.clearIdleTimer();
    this.child?.kill();
  }
}

class FeynmanBridge {
  constructor() {
    this.sessions = new Map();
  }

  async createSession(conversationId) {
    if (this.sessions.has(conversationId)) {
      return this.sessions.get(conversationId);
    }
    const session = new FeynmanSession(conversationId);
    await session.start();
    session.once('closed', () => this.sessions.delete(conversationId));
    this.sessions.set(conversationId, session);
    return session;
  }

  getSession(conversationId) {
    return this.sessions.get(conversationId) ?? null;
  }

  sendMessage(conversationId, message) {
    const session = this.getSession(conversationId);
    if (!session) {
      throw new Error('Feynman session not found');
    }
    session.prompt(message);
  }

  endSession(conversationId) {
    const session = this.sessions.get(conversationId);
    if (!session) return;
    session.stop();
    this.sessions.delete(conversationId);
  }
}

export const feynmanBridge = new FeynmanBridge();
export { FeynmanSession };
