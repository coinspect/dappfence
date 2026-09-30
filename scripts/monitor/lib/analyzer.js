/**
 * Analyzer interface. An analyzer receives an Observation, may attach annotations,
 * and returns the (mutated) Observation. Analyzers must not throw on unrecognized
 * input — return the observation unchanged.
 *
 * Register analyzers in scripts/monitor/run.js. The default set is rule-based only.
 * To add an LLM analyzer later, implement this shape and register it — no change
 * to monitors or orchestrator required.
 */

/**
 * @typedef {import('./observation.js')} Observation
 * @typedef {(obs: Observation) => Promise<Observation>} Analyzer
 */

/** No-op analyzer, used as a placeholder in tests and when no analyzers registered. */
export const nullAnalyzer = async (obs) => obs;

/** Run a list of analyzers over an observation in order. Each may attach annotations. */
export async function runAnalyzers(obs, analyzers) {
    for (const analyzer of analyzers) {
        try {
            await analyzer(obs);
        } catch (err) {
            obs.annotations.push({
                source: 'analyzer-error',
                note: `${analyzer.name || 'anonymous'}: ${err.message}`,
                confidence: 1,
                suggest: null,
                model: null,
            });
        }
    }
    return obs;
}
