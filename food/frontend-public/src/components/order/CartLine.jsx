import QuantitySelector from './QuantitySelector';
import MediaImage from '../MediaImage';

export default function CartLine({ line, onQuantity, onRemove, onNotes, compact = false }) {
  return (
    <article className={`cart-line ${compact ? 'compact' : ''}`}>
      <div className="cart-line-image"><MediaImage src={line.image} alt="" /></div>
      <div className="cart-line-copy">
        <h3>{line.name}</h3>
        <p>{compact ? `Qty ${line.quantity}` : line.description}</p>
        {line.modifiers?.length > 0 && <p className="cart-modifiers">{line.modifiers.map((modifier) => modifier.optionName).join(' · ')}</p>}
        {!compact && <input value={line.notes} onChange={(event) => onNotes(line.id, event.target.value)} placeholder="Special instructions" aria-label={`Special instructions for ${line.name}`} />}
        {!compact && <button className="text-button" type="button" onClick={() => onRemove(line.id)}>Remove</button>}
      </div>
      {!compact && <QuantitySelector quantity={line.quantity} onChange={(quantity) => onQuantity(line.id, quantity)} />}
      <strong>${(line.unitPrice * line.quantity).toFixed(2)}</strong>
    </article>
  );
}
