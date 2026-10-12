import { useState } from 'react';
import Header from '../../components/Header';
import Footer from '../../components/Footer';
import FormField from '../../components/forms/FormField';
import { useCart } from '../../state/cart/CartContext';

export default function OrderDetailsPage() {
  const { lines, orderDetails, setOrderDetails } = useCart();
  const [form, setForm] = useState(orderDetails);
  const [errors, setErrors] = useState({});
  const update = (name, value) => setForm((current) => ({ ...current, [name]: value }));
  const submit = (event) => {
    event.preventDefault();
    const next = {};
    if (!form.fullName.trim()) next.fullName = 'Name is required.';
    if (!form.phone.trim()) next.phone = 'Phone is required.';
    if (form.email && !/^\S+@\S+\.\S+$/.test(form.email)) next.email = 'Enter a valid email.';
    if (!form.pickupTime) next.pickupTime = 'Choose a pickup time.';
    if (!lines.length) next.cart = 'Add at least one item before continuing.';
    setErrors(next);
    if (Object.keys(next).length) return;
    const requestedAt = new Date(); const [hours, minutes] = form.pickupTime.split(':').map(Number); requestedAt.setHours(hours, minutes, 0, 0); if (requestedAt <= new Date()) requestedAt.setDate(requestedAt.getDate() + 1);
    setOrderDetails({ ...form, requestedAt: requestedAt.toISOString() });
    window.location.href = '/order/review';
  };
  return <main className="order-flow-page"><Header showSignIn={false} /><div className="order-flow-shell"><form className="order-panel details-panel" onSubmit={submit} noValidate><b>GUEST CHECKOUT</b><h1>Order details</h1><p>No account required.</p><div className="panel-rule" /><FormField label="NAME" value={form.fullName} onChange={(e) => update('fullName', e.target.value)} placeholder="Your name" error={errors.fullName} /><FormField label="PHONE" value={form.phone} onChange={(e) => update('phone', e.target.value)} placeholder="Mobile number" error={errors.phone} /><FormField label="EMAIL" value={form.email} onChange={(e) => update('email', e.target.value)} placeholder="Email address (optional)" error={errors.email} type="email" /><FormField label="ORDER METHOD" as="select" value={form.method} onChange={(e) => update('method', e.target.value)}><option>Pickup / Order Ahead</option></FormField><FormField label="PICKUP TIME" value={form.pickupTime} onChange={(e) => update('pickupTime', e.target.value)} error={errors.pickupTime} type="time" /><FormField label="ORDER NOTES" value={form.orderNotes} onChange={(e) => update('orderNotes', e.target.value)} placeholder="Special instructions (optional)" />{errors.cart && <p className="form-error">{errors.cart}</p>}<button className="order-primary" type="submit">REVIEW ORDER</button></form></div><Footer simple /></main>;
}
