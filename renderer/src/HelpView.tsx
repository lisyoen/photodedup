import type { MouseEvent, ReactNode } from "react";
import { useT } from "./i18n";

const WORKFLOW_KEYS = [
  "help.workflow.step1",
  "help.workflow.step2",
  "help.workflow.step3",
  "help.workflow.step4"
] as const;

const PIPELINE_KEYS = [
  "help.pipeline.scan",
  "help.pipeline.cache",
  "help.pipeline.fingerprint",
  "help.pipeline.grouping",
  "help.pipeline.recommend",
  "help.pipeline.review",
  "help.pipeline.apply"
] as const;

const SIMILARITY_KEYS = [
  "help.similarity.fingerprints",
  "help.similarity.formula",
  "help.similarity.threshold",
  "help.similarity.grouping",
  "help.similarity.recheck"
] as const;

const KEEP_KEYS = [
  "help.keep.formula",
  "help.keep.original",
  "help.keep.finalChoice"
] as const;

const DISPLAY_KEYS = [
  "help.display.badges",
  "help.display.groupHeader",
  "help.display.marks",
  "help.display.actions",
  "help.display.shortcuts"
] as const;

export function HelpView({ onClose }: { onClose: () => void }) {
  const { t } = useT();

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="help-title"
      onClick={onClose}
    >
      <article className="modal help-modal" onClick={(event: MouseEvent) => event.stopPropagation()}>
        <header className="help-header">
          <div>
            <p className="eyebrow">{t("help.eyebrow")}</p>
            <h2 id="help-title">{t("help.title")}</h2>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label={t("help.close")}
            title={t("help.close")}
          >
            x
          </button>
        </header>

        <div className="modal-body">
          <ManualSection title={t("help.workflow.title")}>
            <ol className="help-list ordered">
              {WORKFLOW_KEYS.map((key) => <li key={key}>{t(key)}</li>)}
            </ol>
          </ManualSection>

          <ManualSection title={t("help.pipeline.title")}>
            <ul className="help-list">
              {PIPELINE_KEYS.map((key) => <li key={key}>{t(key)}</li>)}
            </ul>
          </ManualSection>

          <ManualSection title={t("help.similarity.title")}>
            <ul className="help-list">
              {SIMILARITY_KEYS.map((key) => <li key={key}>{t(key)}</li>)}
            </ul>
          </ManualSection>

          <ManualSection title={t("help.keep.title")}>
            <ul className="help-list">
              {KEEP_KEYS.map((key) => <li key={key}>{t(key)}</li>)}
            </ul>
          </ManualSection>

          <ManualSection title={t("help.display.title")}>
            <ul className="help-list">
              {DISPLAY_KEYS.map((key) => <li key={key}>{t(key)}</li>)}
            </ul>
          </ManualSection>
        </div>
      </article>
    </div>
  );
}

function ManualSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="help-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
