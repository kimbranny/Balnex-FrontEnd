import { useState } from "react";
import { clearLinks, FIELDS, loadLinks, saveLinks, validateUrl } from "../lib/socialLinks";

// A self-contained card. It never touches authorities, fees, metadata, supply, transactions
// or the lifecycle lock; it only reads/writes this token's local links.
export default function SocialLinks({ mint }) {
  const [saved, setSaved] = useState(() => loadLinks(mint));
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState({});
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState("");
  const hasLinks = Object.keys(saved).length > 0;

  function startEdit() {
    setValues({ ...saved });
    setErrors({});
    setMessage("");
    setEditing(true);
  }

  function change(id, value) {
    setValues((prev) => ({ ...prev, [id]: value }));
    setErrors((prev) => ({ ...prev, [id]: validateUrl(value) }));
  }

  function save() {
    const result = saveLinks(mint, values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setSaved(loadLinks(mint));
    setEditing(false);
    setMessage("Links saved on this device.");
  }

  function clear() {
    clearLinks(mint);
    setSaved({});
    setValues({});
    setErrors({});
    setEditing(false);
    setMessage("Links cleared.");
  }

  return (
    <section className="social-card" aria-label="Social links">
      <div className="pool-head">
        <div>
          <h4>Social Links</h4>
          <small className="helper">Optional. Shown here only and stored in this browser. Nothing is sent on-chain.</small>
        </div>
        {!editing && (
          <button type="button" className="secondary-button compact" onClick={startEdit}>
            {hasLinks ? "Edit" : "Add links"}
          </button>
        )}
      </div>

      {!editing && hasLinks && (
        <ul className="social-links">
          {FIELDS.filter(({ id }) => saved[id]).map(({ id, label }) => (
            <li key={id}>
              <a href={saved[id]} target="_blank" rel="noopener noreferrer">
                {label.replace(" (optional)", "")} ↗
              </a>
            </li>
          ))}
        </ul>
      )}
      {!editing && !hasLinks && <p className="helper">No links added yet.</p>}
      {message && !editing && <small className="helper" role="status">{message}</small>}

      {editing && (
        <>
          <div className="social-grid">
            {FIELDS.map(({ id, label, placeholder }) => (
              <div className="field social-field" key={id}>
                <label htmlFor={`social-${mint}-${id}`}>{label}</label>
                <input
                  id={`social-${mint}-${id}`}
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  placeholder={placeholder}
                  value={values[id] || ""}
                  className={errors[id] ? "invalid" : ""}
                  aria-invalid={!!errors[id]}
                  onChange={(e) => change(id, e.target.value)}
                />
                {errors[id] && <div className="social-error">{errors[id]}</div>}
              </div>
            ))}
          </div>
          {errors._ && <div className="social-error">{errors._}</div>}
          <div className="button-row">
            <button type="button" className="secondary-button compact" onClick={() => setEditing(false)}>
              Cancel
            </button>
            {hasLinks && (
              <button type="button" className="text-button danger-text" onClick={clear}>
                Clear all
              </button>
            )}
            <button type="button" className="primary" onClick={save}>
              Save links
            </button>
          </div>
        </>
      )}
    </section>
  );
}
