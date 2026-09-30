/**
 * An Observation is one datum a monitor produced this run.
 * Analyzers (rule-based today, LLM tomorrow) attach annotations.
 * The alerter reads severity + annotations to decide what to dispatch.
 */

export const SEVERITY = Object.freeze({
    INFO: 'info',
    WARN: 'warn',
    ALARM: 'alarm',
});

export function makeObservation({ monitor, subject, severity, title, details = {} }) {
    if (!monitor || !subject || !severity || !title) {
        throw new Error('observation requires monitor, subject, severity, title');
    }
    if (!Object.values(SEVERITY).includes(severity)) {
        throw new Error(`invalid severity: ${severity}`);
    }
    return {
        id: `${monitor}:${subject}:${Date.now()}`,
        timestamp: new Date().toISOString(),
        monitor,
        subject,
        severity,
        title,
        details,
        annotations: [],
    };
}

/**
 * An annotation is a structured note from an analyzer.
 * source:     identifier of the analyzer ('rules', 'llm-haiku', 'llm-opus', ...)
 * note:       human-readable finding
 * confidence: 0..1 (analyzers self-report; the alerter may weight it)
 * suggest:    optional severity re-recommendation (never overrides monitor severity)
 * model:      optional model identifier for LLM analyzers, for audit
 */
export function annotate(obs, { source, note, confidence = 1, suggest = null, model = null }) {
    if (!source || !note) {
        throw new Error('annotation requires source and note');
    }
    obs.annotations.push({ source, note, confidence, suggest, model });
    return obs;
}
