import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { configManager } from './configManager.js';

const REQUEST_PREFIX = 'pipeline_request_';
const RESULT_PREFIX = 'hypotheses_';

/**
 * Normalizes a user-supplied slug (or generates one) so it is always a safe
 * ASCII filename fragment. Goal/constraints text may be Cyrillic; the slug
 * itself stays ASCII to avoid encoding surprises across platforms.
 */
export function sanitizeSlug(rawSlug) {
  const cleaned = String(rawSlug ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned || `run-${Date.now()}`;
}

function getAccelmatSettings() {
  return configManager.settings?.accelmat ?? {};
}

export function getAccelmatDir() {
  const relative = getAccelmatSettings().projectDir
    ?? '../Hypothesis-Generation-for-Materials-Discovery-and-Design-Using-Goal-Driven-and-Constraint-Guided-LLM';
  return path.resolve(configManager.getProjectRoot(), relative);
}

export function getAccelmatPythonExecutable() {
  return getAccelmatSettings().pythonExecutable ?? 'python';
}

export function getAccelmatDefaults() {
  return {
    maxRefinementIterations: 1,
    numHypotheses: 5,
    ...(getAccelmatSettings().defaults ?? {}),
  };
}

function requestPath(slug) {
  return path.join(getAccelmatDir(), 'inputs', `${REQUEST_PREFIX}${slug}.json`);
}

function resultPath(slug) {
  return path.join(getAccelmatDir(), 'output', `${RESULT_PREFIX}${slug}.json`);
}

export async function writeRequest(slug, { graphPath, goal, constraints, maxRefinementIterations, numHypotheses }) {
  const target = requestPath(slug);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const defaults = getAccelmatDefaults();
  const payload = {
    graph_path: graphPath,
    goal,
    constraints: constraints ?? [],
    max_refinement_iterations: maxRefinementIterations ?? defaults.maxRefinementIterations,
    num_hypotheses: numHypotheses ?? defaults.numHypotheses,
  };
  await fs.writeFile(target, JSON.stringify(payload, null, 2), 'utf8');
  return { requestPath: target, payload };
}

export async function readResult(slug) {
  const raw = await fs.readFile(resultPath(slug), 'utf8');
  return JSON.parse(raw);
}

export async function listResults() {
  const outputDir = path.join(getAccelmatDir(), 'output');
  let entries;
  try {
    entries = await fs.readdir(outputDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(RESULT_PREFIX) || !entry.name.endsWith('.json')) continue;
    const slug = entry.name.slice(RESULT_PREFIX.length, -'.json'.length);
    const fullPath = path.join(outputDir, entry.name);
    try {
      const stat = await fs.stat(fullPath);
      const raw = await fs.readFile(fullPath, 'utf8');
      const parsed = JSON.parse(raw);
      results.push({
        slug,
        goal: parsed.goal,
        hypothesesCount: Object.keys(parsed.hypotheses ?? {}).length,
        critsApproved: parsed.metadata?.critics_approved ?? null,
        modifiedAt: stat.mtime.toISOString(),
      });
    } catch {
      // Skip unreadable/partial files.
    }
  }
  return results.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export async function listGraphs() {
  const graphsDir = path.join(getAccelmatDir(), 'Examples_prev_step');
  let entries;
  try {
    entries = await fs.readdir(graphsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && entry.name.startsWith('LearningChunkGraph'))
    .map((entry) => `Examples_prev_step/${entry.name}`)
    .sort();
}

/**
 * Executes ACCELMAT's run_pipeline.py for the given slug via spawn, mirroring
 * pipelineRunner.runStage's log-streaming pattern.
 */
export function runAccelmat(slug, onLog = () => {}) {
  return new Promise((resolve, reject) => {
    const python = getAccelmatPythonExecutable();
    const accelmatDir = getAccelmatDir();
    const args = [
      'run_pipeline.py',
      '--request', path.join('inputs', `${REQUEST_PREFIX}${slug}.json`),
      '--output', path.join('output', `${RESULT_PREFIX}${slug}.json`),
    ];

    onLog({ level: 'info', message: `Starting ACCELMAT run for slug "${slug}"` });

    const child = spawn(python, args, {
      cwd: accelmatDir,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) onLog({ level: 'info', message: line.trim() });
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) onLog({ level: 'warn', message: line.trim() });
      }
    });

    child.on('error', (error) => {
      reject(new Error(`Failed to launch ACCELMAT (is "${python}" on PATH?): ${error.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ slug, stdout, stderr });
      } else {
        reject(new Error(`ACCELMAT run_pipeline.py failed with exit code ${code}`));
      }
    });
  });
}
