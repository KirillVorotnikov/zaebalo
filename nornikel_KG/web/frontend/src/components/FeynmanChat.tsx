import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, subscribeFeynmanSession, type AccelmatResult, type FeynmanToolEvent } from '../api/client';

export interface FeynmanChatProps {
  seedContext?: { slug: string; suggestionKey: string; goal: string } | null;
  onNavigateToAccelmat?: () => void;
}

interface ToolActivity {
  toolName: string;
  toolCallId: string;
  done: boolean;
  isError?: boolean;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  tools: ToolActivity[];
}

const ACCELMAT_DIR = 'Hypothesis-Generation-for-Materials-Discovery-and-Design-Using-Goal-Driven-and-Constraint-Guided-LLM';

function resultFilePath(slug: string): string {
  // Feynman's tools run with cwd at the workspace root, not inside the ACCELMAT
  // project directory, so the path must be given relative to that root.
  return `${ACCELMAT_DIR}/output/hypotheses_${slug}.json`;
}

function buildSeedMessage(context: { slug: string; suggestionKey: string; goal: string }): string {
  const parts = [`Обсуди результат ACCELMAT`];
  if (context.slug) parts.push(`(файл ${resultFilePath(context.slug)})`);
  parts.push(`гипотезу ${context.suggestionKey}.`);
  if (context.goal) parts.push(`Цель: ${context.goal}`);
  return parts.join(' ');
}

function buildDiscussAllMessage(slug: string, goal: string): string {
  return `Прочитай результат ACCELMAT (файл ${resultFilePath(slug)}) и обсуди все гипотезы: сравни их сильные и слабые стороны, ` +
    `и порекомендуй лучшую с учётом цели и ограничений. Цель: ${goal}`;
}

function sortedSuggestionKeys(result: AccelmatResult): string[] {
  const keys = Object.keys(result.hypotheses ?? {});
  const scores = result.evaluation?.scores ?? {};
  return keys.slice().sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));
}

function ThinkingDots() {
  return (
    <span className="feynman-thinking" aria-label="Feynman is thinking">
      <span />
      <span />
      <span />
    </span>
  );
}

function ToolChip({ tool }: { tool: ToolActivity }) {
  return (
    <span className={`feynman-tool-chip${tool.done ? ' done' : ' running'}${tool.isError ? ' error' : ''}`}>
      <span className="feynman-tool-dot" />
      <code>{tool.toolName}</code>
    </span>
  );
}

function AssistantContent({ message, showCursor }: { message: ChatMessage; showCursor: boolean }) {
  return (
    <div className="feynman-markdown">
      {message.tools.length > 0 && (
        <div className="feynman-tool-row">
          {message.tools.map((tool) => <ToolChip key={tool.toolCallId} tool={tool} />)}
        </div>
      )}
      {message.text && (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
      )}
      {showCursor && <span className="feynman-cursor" />}
    </div>
  );
}

export function FeynmanChat({ seedContext, onNavigateToAccelmat }: FeynmanChatProps) {
  const { t } = useTranslation();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(true);
  const [latestSlug, setLatestSlug] = useState<string | null>(null);
  const [latestResult, setLatestResult] = useState<AccelmatResult | null>(null);
  const [loadingResult, setLoadingResult] = useState(true);
  const streamCleanup = useRef<(() => void) | null>(null);
  const seedSentFor = useRef<string | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    connect();
    loadLatestAccelmatResult();
    return () => {
      streamCleanup.current?.();
      if (conversationIdRef.current) api.endFeynmanSession(conversationIdRef.current).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadLatestAccelmatResult() {
    setLoadingResult(true);
    try {
      const { results } = await api.listAccelmatResults();
      const latest = results[0];
      if (!latest) {
        setLatestSlug(null);
        setLatestResult(null);
        return;
      }
      const { result } = await api.getAccelmatResult(latest.slug);
      setLatestSlug(latest.slug);
      setLatestResult(result);
    } catch {
      setLatestSlug(null);
      setLatestResult(null);
    } finally {
      setLoadingResult(false);
    }
  }

  useEffect(() => {
    if (!conversationId || !seedContext) return;
    const key = `${seedContext.slug}:${seedContext.suggestionKey}`;
    if (seedSentFor.current === key) return;
    seedSentFor.current = key;
    void sendMessage(buildSeedMessage(seedContext));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, seedContext]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, isThinking]);

  function connect() {
    setConnecting(true);
    setError(null);
    api.createFeynmanSession().then(({ conversationId: id }) => {
      conversationIdRef.current = id;
      setConversationId(id);
      setConnecting(false);
      streamCleanup.current = subscribeFeynmanSession(id, {
        onDelta: (text) => {
          setIsThinking(false);
          appendAssistantDelta(text);
        },
        onTool: (event) => {
          setIsThinking(false);
          handleToolEvent(event);
        },
        onTurnEnd: () => {
          setIsStreaming(false);
          setIsThinking(false);
        },
        onError: (message) => {
          setError(message);
          setIsStreaming(false);
          setIsThinking(false);
        },
        onClosed: () => {
          setIsStreaming(false);
          setIsThinking(false);
        },
      });
    }).catch((err) => {
      setError(err instanceof Error ? err.message : t('errors.generic'));
      setConnecting(false);
    });
  }

  function appendAssistantDelta(text: string) {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant') {
        return [...prev.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...prev, { role: 'assistant', text, tools: [] }];
    });
  }

  function handleToolEvent(event: FeynmanToolEvent) {
    setMessages((prev) => {
      let last = prev[prev.length - 1];
      if (last?.role !== 'assistant') {
        last = { role: 'assistant', text: '', tools: [] };
        prev = [...prev, last];
      }
      const tools = event.phase === 'start'
        ? [...last.tools, { toolName: event.toolName, toolCallId: event.toolCallId, done: false }]
        : last.tools.map((tool) => (tool.toolCallId === event.toolCallId ? { ...tool, done: true, isError: event.isError } : tool));
      return [...prev.slice(0, -1), { ...last, tools }];
    });
  }

  async function sendMessage(text: string) {
    if (!conversationId || !text.trim()) return;
    setMessages((prev) => [...prev, { role: 'user', text, tools: [] }]);
    setIsStreaming(true);
    setIsThinking(true);
    setError(null);
    try {
      await api.sendFeynmanMessage(conversationId, text);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.generic'));
      setIsStreaming(false);
      setIsThinking(false);
    }
  }

  function handleSubmit() {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    void sendMessage(text);
  }

  function discussHypothesis(suggestionKey: string) {
    if (!latestSlug || !latestResult || isStreaming || connecting) return;
    void sendMessage(buildSeedMessage({ slug: latestSlug, suggestionKey, goal: latestResult.goal }));
  }

  function discussAllHypotheses() {
    if (!latestSlug || !latestResult || isStreaming || connecting) return;
    void sendMessage(buildDiscussAllMessage(latestSlug, latestResult.goal));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function handleNewChat() {
    streamCleanup.current?.();
    if (conversationIdRef.current) api.endFeynmanSession(conversationIdRef.current).catch(() => {});
    conversationIdRef.current = null;
    seedSentFor.current = null;
    setConversationId(null);
    setMessages([]);
    setIsStreaming(false);
    setIsThinking(false);
    setError(null);
    connect();
    loadLatestAccelmatResult();
  }

  function autoGrow(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
  }

  const hypothesisKeys = latestResult ? sortedSuggestionKeys(latestResult) : [];
  const sidebarDisabled = connecting || isStreaming || !latestResult;

  return (
    <div className="feynman-layout">
      <aside className="feynman-sidebar">
        <h3>{t('chat.latest_run')}</h3>
        {loadingResult && <p className="hint">{t('common.loading')}</p>}
        {!loadingResult && !latestResult && (
          <div className="feynman-sidebar-empty">
            <p className="hint">{t('chat.no_runs')}</p>
            {onNavigateToAccelmat && (
              <button type="button" className="btn-secondary" onClick={onNavigateToAccelmat}>
                {t('chat.go_to_accelmat')}
              </button>
            )}
          </div>
        )}
        {latestResult && (
          <>
            <p className="feynman-sidebar-goal">{latestResult.goal}</p>
            <button type="button" className="btn-secondary feynman-discuss-all" onClick={discussAllHypotheses} disabled={sidebarDisabled}>
              {t('chat.discuss_all')}
            </button>
            <ul className="feynman-hypothesis-list">
              {hypothesisKeys.map((key) => {
                const hypothesis = latestResult.hypotheses[key];
                const score = latestResult.evaluation?.scores?.[key];
                return (
                  <li key={key}>
                    <button type="button" onClick={() => discussHypothesis(key)} disabled={sidebarDisabled}>
                      <span className="feynman-hypothesis-score">{score ?? '—'}/10</span>
                      <span className="feynman-hypothesis-name">{hypothesis.Materials}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </aside>

      <div className="feynman-page">
        <div className="feynman-page-header">
          <div>
            <h2>{t('chat.title')}</h2>
            <span className="feynman-status">
              {connecting ? t('chat.connecting') : error ? t('chat.status_error') : isStreaming ? t('chat.status_thinking') : t('chat.status_ready')}
            </span>
          </div>
          <button type="button" className="btn-secondary" onClick={handleNewChat} disabled={connecting}>
            {t('chat.new_chat')}
          </button>
        </div>

        <div className="feynman-messages">
          {messages.length === 0 && !connecting && (
            <div className="feynman-empty">
              <p>{t('chat.empty')}</p>
            </div>
          )}
          {messages.map((message, index) => {
            const isLast = index === messages.length - 1;
            return (
              <div key={index} className={`feynman-message ${message.role}`}>
                {message.role === 'user' ? (
                  <div className="feynman-bubble">{message.text}</div>
                ) : (
                  <AssistantContent message={message} showCursor={isLast && isStreaming && !isThinking} />
                )}
              </div>
            );
          })}
          {isThinking && (
            <div className="feynman-message assistant">
              <ThinkingDots />
            </div>
          )}
          {error && <p className="upload-message err">{error}</p>}
          <div ref={messagesEndRef} />
        </div>

        <div className="feynman-input-bar">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={autoGrow}
            onKeyDown={handleKeyDown}
            placeholder={t('chat.placeholder')}
            disabled={connecting}
            rows={1}
          />
          <button type="button" className="feynman-send-btn" onClick={handleSubmit} disabled={connecting || isStreaming || !input.trim()}>
            {t('chat.send')}
          </button>
        </div>
      </div>
    </div>
  );
}
