import { useState } from 'react';
import Header from '../../components/Header';
import Footer from '../../components/Footer';
import CartLine from '../../components/order/CartLine';
import OrderSummary from '../../components/order/OrderSummary';
import { useCart } from '../../state/cart/CartContext';
import { rememberOrderCredential, submitOrder } from '../../lib/foodops';

export default function ReviewOrderPage() {
  const { lines, subtotal, orderDetails, clearCart } = useCart();
  const [submitting, setSubmitting] = useState(false); const [submitError, setSubmitError] = useState('');
  const placeOrder = async () => {
    if (!lines.length) return;
    setSubmitting(true); setSubmitError('');
    try {
      const response = await submitOrder({ customerName: orderDetails.fullName, customerPhone: orderDetails.phone, customerEmail: orderDetails.email || null,
        orderType: 'TAKEOUT', requestedAt: orderDetails.requestedAt, customerInstructions: orderDetails.orderNotes || '', termsAccepted: true, payOnSiteAccepted: true,
        items: lines.map((line) => ({ itemId: Number(line.menuItemId), quantity: line.quantity, notes: line.notes || '', modifierOptionIds: line.modifierOptionIds || [] })) });
      rememberOrderCredential(response.orderNumber, response.accessToken); clearCart(); window.location.href = `/order/confirmation/${response.orderNumber}`;
    } catch (error) { setSubmitError(error.message); } finally { setSubmitting(false); }
  };
  return <main className="order-flow-page"><Header showSignIn={false} /><div className="order-flow-shell"><section className="order-panel review-panel"><b>BEFORE YOU PLACE IT</b><h1>Review order</h1><p>Check the details one more time.</p><div className="panel-rule" /><div className="review-details"><div><b>Pickup</b><span>Silk Road Grill at Trucker Heaven</span></div><div><b>Address</b><span>8037 Eastgate Blvd, Mt. Juliet, TN 37122</span></div><div><b>Customer</b><span>{orderDetails.fullName || 'Not provided'} · {orderDetails.phone || 'No phone'}{orderDetails.email ? ` · ${orderDetails.email}` : ''}</span></div><div><b>Pickup time</b><span>{orderDetails.pickupTime || 'Not selected'}</span></div>{orderDetails.orderNotes && <div><b>Order notes</b><span>{orderDetails.orderNotes}</span></div>}</div><div className="panel-rule" />{lines.length ? <div className="cart-lines review-lines">{lines.map((line) => <CartLine key={`${line.id}-${line.notes}`} line={line} compact />)}</div> : <div className="empty-cart"><p>No order items are available to review.</p><a href="/menu">RETURN TO MENU</a></div>}<OrderSummary subtotal={subtotal} /><div className="payment-placeholder"><b>PAY ON SITE</b><p>Payment is collected at pickup. No card information is collected on this site.</p></div>{submitError && <p className="form-error" role="alert">{submitError}</p>}<button className="order-primary" type="button" onClick={placeOrder} disabled={!lines.length || submitting}>{submitting ? 'PLACING ORDER…' : 'PLACE ORDER — PAY ON SITE'}</button></section></div><Footer simple /></main>;
}
