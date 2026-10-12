export default function FormField({ label, error, className = '', as = 'input', ...props }) {
  const Element = as;
  return (
    <label className={`form-field ${className}`}>
      <span>{label}</span>
      <Element {...props} aria-invalid={Boolean(error)} />
      {error && <small>{error}</small>}
    </label>
  );
}
