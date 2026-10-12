export default function QuantitySelector({ quantity, onChange }) {
  return (
    <div className="quantity-selector" aria-label="Quantity">
      <button type="button" onClick={() => onChange(quantity - 1)} aria-label="Decrease quantity">−</button>
      <span>{quantity}</span>
      <button type="button" onClick={() => onChange(quantity + 1)} aria-label="Increase quantity">+</button>
    </div>
  );
}
