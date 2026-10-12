export default function OrderSummary({ subtotal }) {
  return (
    <div className="order-summary">
      <div><span>Subtotal</span><strong>${subtotal.toFixed(2)}</strong></div>
      <div><span>Tax</span><span>Not calculated yet</span></div>
      <div><span>Total before payment</span><strong>${subtotal.toFixed(2)} + tax</strong></div>
    </div>
  );
}
