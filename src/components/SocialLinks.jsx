import { useEffect, useState } from "react";
import { clearSocialLinks, loadSocialLinks, saveSocialLinks, SOCIAL_FIELDS, validateSocialUrl } from "../lib/socialLinks";

export default function SocialLinks({ mint }) {
  const [values, setValues] = useState({});
  const [errors, setErrors] = useState({});
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setValues(loadSocialLinks(mint));
    setErrors({});
    setEditing(false);
    setNotice("");
  }, [mint]);

  const saved = SOCIAL_FIELDS.filter((field) => values[field.key]);

  function change(key, value) {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: validateSocialUrl(value) }));
    setNotice("");
  }

  function save() {
    const nextErrors = Object.fromEntries(SOCIAL_FIELDS.map((field) => [field.key, validateSocialUrl(values[field.key])]).filter(([, error]) => error));
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    try {
      const stored = saveSocialLinks(mint, values);
      setValues(stored);
      setEditing(false);
      setNotice("Social links saved for this token.");
    } catch (error) {
      setNotice(error?.message || "Couldn't save social links in this browser.");
    }
  }

  function clear() {
    try {
      clearSocialLinks(mint);
      setValues({});
      setErrors({});
      setEditing(false);
      setNotice("Social links cleared for this token.");
    } catch (error) {
      setNotice(error?.message || "Couldn't clear social links.");
    }
  }

  return (
    <section className="social-links-card" aria-label="Social links">
      <div className="social-links-head">
        <div>
          <span className="eyebrow">COMMUNITY</span>
          <h3>Social Links</h3>
          <p className="helper">Optional links saved privately in this browser for this token only. No blockchain transaction.</p>
        </div>
        {!editing && <button type="button" className="secondary-button compact" onClick={() => setEditing(true)}>Edit links</button>}
      </div>

      {editing ? (
        <div className="social-links-form">
          {SOCIAL_FIELDS.map((field) => (
            <div className="field" key={field.key}>
              <label htmlFor={`social-${mint}-${field.key}`}>{field.label} <span className="helper">(optional)</span></label>
              <input
                id={`social-${mint}-${field.key}`}
                type="url"
                inputMode="url"
                autoComplete="url"
                placeholder={field.placeholder}
                value={values[field.key] || ""}
                aria-invalid={Boolean(errors[field.key])}
                aria-describedby={errors[field.key] ? `social-error-${mint}-${field.key}` : undefined}
                onChange={(event) => change(field.key, event.target.value)}
              />
              {errors[field.key] && <small className="social-link-error" id={`social-error-${mint}-${field.key}`}>{errors[field.key]}</small>}
            </div>
          ))}
          <div className="button-row">
            <button type="button" className="primary" onClick={save}>Save links</button>
            <button type="button" className="secondary-button" onClick={() => { setValues(loadSocialLinks(mint)); setErrors({}); setEditing(false); }}>Cancel</button>
            <button type="button" className="text-button danger-text" onClick={clear}>Clear all</button>
          </div>
        </div>
      ) : saved.length ? (
        <div className="social-links-list">
          {saved.map((field) => (
            <a key={field.key} href={values[field.key]} target="_blank" rel="noopener noreferrer nofollow">
              <span>{field.label}</span><strong>{values[field.key].replace(/^https?:\/\//i, "")}</strong><span aria-hidden="true">↗</span>
            </a>
          ))}
          <button type="button" className="text-button danger-text" onClick={clear}>Clear saved links</button>
        </div>
      ) : (
        <div className="social-links-empty">
          <span>No social links added yet.</span>
          <button type="button" className="text-button" onClick={() => setEditing(true)}>Add optional links</button>
        </div>
      )}
      {notice && <p className="helper" role="status">{notice}</p>}
    </section>
  );
}
