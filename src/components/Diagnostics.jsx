import { useToast } from "./Toast";

// Expandable technical details for a failed transaction. Contains no keys or seed
// phrases; only error text, program logs, signature and RPC status.
export default function Diagnostics({ data }) {
  const notify = useToast();
  if (!data) return null;

  const text = JSON.stringify(data, null, 2);

  function copy() {
    navigator.clipboard?.writeText(text).then(
      () => notify("Diagnostics copied.", "success"),
      () => notify("Couldn't copy automatically.", "error")
    );
  }

  return (
    <details className="diagnostics">
      <summary>Technical details</summary>
      <pre className="diag-pre">{text}</pre>
      <button type="button" className="text-button" onClick={copy}>
        Copy diagnostics
      </button>
    </details>
  );
}
