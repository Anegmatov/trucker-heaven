import { useCart } from '../../state/cart/CartContext';
import CartLine from './CartLine';
import OrderSummary from './OrderSummary';

export default function CartPanel({ onClose }) {
  const { lines, setQuantity, removeItem, updateNotes, clearCart, subtotal } = useCart();
  return (
    <section className="order-panel cart-panel">
      <header><div><b>YOUR ORDER</b><h1>Cart</h1><p>Review your items before continuing.</p></div>{onClose && <button type="button" onClick={onClose} aria-label="Close cart">×</button>}</header>
      <div className="panel-rule" />
      {lines.length ? <>
        <div className="cart-lines">{lines.map((line) => <CartLine key={`${line.id}-${line.notes}`} line={line} onQuantity={setQuantity} onRemove={removeItem} onNotes={updateNotes} />)}</div>
        <div className="cart-utilities"><a href="/menu">+ Add another item</a><button type="button" onClick={clearCart}>Clear cart</button></div>
        <OrderSummary subtotal={subtotal} />
        <a className="order-primary" href="/order/details">CONTINUE</a>
      </> : <div className="empty-cart"><h2>Your cart is empty.</h2><p>Add a menu item to start a pickup order.</p><a className="order-primary" href="/menu">VIEW MENU</a></div>}
    </section>
  );
}
