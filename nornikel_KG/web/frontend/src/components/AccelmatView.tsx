import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, subscribeJob, type AccelmatResult, type AccelmatResultSummary, type Job } from '../api/client';

export interface AccelmatViewProps {
  onDiscussHypothesis?: (context: { slug: string; suggestionKey: string; goal: string }) => void;
}

function sortedSuggestionKeys(result: AccelmatResult): string[] {
  const keys = Object.keys(result.hypotheses ?? {});
  const scores = result.evaluation?.scores ?? {};
  return keys.slice().sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));
}

function relatedKgContext(result: AccelmatResult, materials: string): [string, unknown][] {
  const entries = Object.entries(result.kg_context ?? {});
  const matched = entries.filter(([key]) => materials.toLowerCase().includes(key.toLowerCase()));
  return matched.length > 0 ? matched : entries;
}

export function AccelmatView({ onDiscussHypothesis }: AccelmatViewProps) {
  const { t } = useTranslation();
  const [goal, setGoal] = useState('');
  const [constraints, setConstraints] = useState<string[]>(['']);
  const [graphPath, setGraphPath] = useState('');
  const [graphs, setGraphs] = useState<string[]>([]);
  const [numHypotheses, setNumHypotheses] = useState(5);
  const [maxRefinementIterations, setMaxRefinementIterations] = useState(1);
  const [activeJob, setActiveJob] = useState<Job | null>(null);
  const [log, setLog] = useState('');
  const [pastResults, setPastResults] = useState<AccelmatResultSummary[]>([]);
  const [selectedResult, setSelectedResult] = useState<AccelmatResult | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const streamCleanup = useRef<(() => void) | null>(null);

  useEffect(() => {
    api.getAccelmatDefaults().then(({ defaults }) => {
      setNumHypotheses(defaults.numHypotheses);
      setMaxRefinementIterations(defaults.maxRefinementIterations);
    }).catch(() => {});
    api.listAccelmatGraphs().then(({ graphs: list }) => {
      setGraphs(list);
      if (list.length > 0) setGraphPath((prev) => prev || list[0]);
    }).catch(() => {});
    refreshResults();
    api.listJobs().then(({ jobs }) => {
      const running = jobs.find((j) => j.type === 'accelmat' && j.status === 'running');
      if (running) attachJob(running.id);
    }).catch(() => {});

    return () => streamCleanup.current?.();
  }, []);

  async function refreshResults() {
    const { results } = await api.listAccelmatResults().catch(() => ({ results: [] as AccelmatResultSummary[] }));
    setPastResults(results);
  }

  function attachJob(jobId: string) {
    streamCleanup.current?.();
    streamCleanup.current = subscribeJob(jobId, {
      onUpdate: (job) => {
        setActiveJob(job);
        if (job.status === 'completed' && job.result) {
          setSelectedResult(job.result);
          setSelectedSlug((job.payload as { slug?: string } | undefined)?.slug ?? null);
          refreshResults();
        }
        if (job.status === 'failed') {
          setError(job.error ?? t('errors.generic'));
        }
      },
      onLog: (entry) => setLog((prev) => `${prev}${entry.message}\n`),
    });
  }

  function updateConstraint(index: number, value: string) {
    setConstraints((prev) => prev.map((c, i) => (i === index ? value : c)));
  }

  function addConstraint() {
    setConstraints((prev) => [...prev, '']);
  }

  function removeConstraint(index: number) {
    setConstraints((prev) => prev.filter((_, i) => i !== index));
  }

  async function runAccelmat() {
    setError(null);
    if (!goal.trim() || !graphPath) {
      setError(t('accelmat.validation_error'));
      return;
    }
    try {
      const { job } = await api.runAccelmat({
        goal: goal.trim(),
        constraints: constraints.map((c) => c.trim()).filter(Boolean),
        graphPath,
        numHypotheses,
        maxRefinementIterations,
      });
      setActiveJob(job);
      setLog('');
      setSelectedResult(null);
      attachJob(job.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.generic'));
    }
  }

  async function loadPastResult(slug: string) {
    const { result } = await api.getAccelmatResult(slug);
    setSelectedResult(result);
    setSelectedSlug(slug);
    setActiveJob(null);
  }

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const isRunning = activeJob ? ['queued', 'running'].includes(activeJob.status) : false;

  return (
    <div className="panel accelmat-panel">
      <div className="pipeline-header">
        <h2>{t('accelmat.title')}</h2>
      </div>

      <div style={{ display: 'grid', gap: '0.75rem', margin: '1rem 0' }}>
        <label>
          {t('accelmat.goal')}
          <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={3} style={{ width: '100%' }} />
        </label>

        <div>
          <strong>{t('accelmat.constraints')}</strong>
          {constraints.map((c, i) => (
            <div key={i} style={{ display: 'flex', gap: '0.5rem', margin: '0.25rem 0' }}>
              <input value={c} onChange={(e) => updateConstraint(i, e.target.value)} style={{ flex: 1 }} />
              <button type="button" className="upload-remove" onClick={() => removeConstraint(i)}>×</button>
            </div>
          ))}
          <button type="button" className="btn-secondary" onClick={addConstraint}>{t('accelmat.add_constraint')}</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' }}>
          <label>
            {t('accelmat.graph_path')}
            <select value={graphPath} onChange={(e) => setGraphPath(e.target.value)} style={{ width: '100%' }}>
              {graphs.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </label>
          <label>
            {t('accelmat.num_hypotheses')}
            <input type="number" min={1} max={20} value={numHypotheses} onChange={(e) => setNumHypotheses(Number(e.target.value))} style={{ width: '100%' }} />
          </label>
          <label>
            {t('accelmat.max_refinement_iterations')}
            <input type="number" min={0} max={5} value={maxRefinementIterations} onChange={(e) => setMaxRefinementIterations(Number(e.target.value))} style={{ width: '100%' }} />
          </label>
        </div>

        <button type="button" className="btn-primary" onClick={runAccelmat} disabled={isRunning}>
          {isRunning ? t('accelmat.running') : t('accelmat.run')}
        </button>
        {error && <p className="upload-message err">{error}</p>}
      </div>

      {pastResults.length > 0 && (
        <div style={{ margin: '1rem 0' }}>
          <strong>{t('accelmat.past_runs')}</strong>
          <ul className="corpus-list">
            {pastResults.map((r) => (
              <li key={r.slug}>
                <span>{r.goal?.slice(0, 60) ?? r.slug}</span>
                <button type="button" className="btn-secondary" onClick={() => loadPastResult(r.slug)}>{t('accelmat.load')}</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {activeJob && (
        <div className="pipeline-status">
          <span>{activeJob.status}</span>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${activeJob.progress}%` }} />
          </div>
          <span>{activeJob.progress}%</span>
        </div>
      )}
      {(isRunning || log) && <pre className="log-console">{log || t('pipeline.log_placeholder')}</pre>}

      {selectedResult && (
        <div style={{ marginTop: '1.5rem' }}>
          <h3>{t('accelmat.results_title')}</h3>
          <p>{selectedResult.evaluation?.summary}</p>
          {sortedSuggestionKeys(selectedResult).map((key) => {
            const hypothesis = selectedResult.hypotheses[key];
            const score = selectedResult.evaluation?.scores?.[key];
            const isOpen = expanded.has(key);
            return (
              <article key={key} className="hypothesis-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ background: 'var(--accent-blue)', color: '#fff', padding: '0.15rem 0.5rem', borderRadius: 999, fontSize: '0.75rem' }}>
                    {t('accelmat.score')}: {score ?? '—'}/10
                  </span>
                  <button type="button" className="btn-secondary" onClick={() => toggleExpanded(key)}>
                    {isOpen ? t('accelmat.collapse') : t('accelmat.expand')}
                  </button>
                </div>
                <h3>{hypothesis.Materials}</h3>
                {isOpen && (
                  <>
                    <p><strong>{t('accelmat.methods')}:</strong> {hypothesis.Methods_to_develop_the_materials_suggested}</p>
                    <p><strong>{t('accelmat.reasoning')}:</strong> {hypothesis.Reasoning}</p>
                    {relatedKgContext(selectedResult, hypothesis.Materials).length > 0 && (
                      <details>
                        <summary>{t('accelmat.kg_context')}</summary>
                        <pre className="log-console">{JSON.stringify(Object.fromEntries(relatedKgContext(selectedResult, hypothesis.Materials)), null, 2)}</pre>
                      </details>
                    )}
                  </>
                )}
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => onDiscussHypothesis?.({ slug: selectedSlug ?? '', suggestionKey: key, goal: selectedResult.goal })}
                >
                  {t('accelmat.discuss')}
                </button>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
