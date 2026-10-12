import { useState } from 'react';
import Header from '../../components/Header';
import Footer from '../../components/Footer';
import FormField from '../../components/forms/FormField';
import { currentOrderNumber, lookupOrders, rememberOrderCredential } from '../../lib/foodops';

const labels = { PENDING: 'NEW ORDER', CONFIRMED: 'ACCEPTED', PREPARING: 'ACCEPTED', READY: 'READY', COMPLETED: 'COMPLETED', CANCELLED: 'CANCELLED' };
const money = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;

export default function OrderLookupPage() {
  const [form, setForm] = useState({ fullName: '', phone: '' });
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const latest = currentOrderNumber();
  const submit = async (event) => {
    event.preventDefault(); setLoading(true); setError(''); setOrders([]);
    try { setOrders((await lookupOrders(form.fullName, form.phone)).orders); }
    catch (requestError) { setError(requestError.message); }
    finally { setLoading(false); }
  };
  const view = (order) => { rememberOrderCredential(order.orderNumber, order.accessToken); window.location.href = `/order/status/${order.orderNumber}`; };
  return <main className="order-flow-page"><Header showSignIn={false} /><div className="order-flow-shell"><section className="order-panel lookup-panel"><b>VIEW ORDER</b><h1>Find your order</h1><p>Enter the full name and phone number used at checkout.</p>{latest && <a className="recent-order-link" href={`/order/status/${latest}`}>View your latest order in this browser</a>}<div className="panel-rule" /><form className="lookup-form" onSubmit={submit}><FormField label="FULL NAME" value={form.fullName} onChange={(event) => setForm({ ...form, fullName: event.target.value })} placeholder="Full name" /><FormField label="PHONE" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} placeholder="Phone number" /><button className="order-primary" type="submit" disabled={loading}>{loading ? 'SEARCHING…' : 'FIND ORDER'}</button></form>{error && <p className="form-error lookup-error" role="alert">{error}</p>}{orders.length > 0 && <div className="lookup-results"><h2>{orders.length === 1 ? 'Recent order' : 'Recent orders'}</h2>{orders.map((order) => <button type="button" onClick={() => view(order)} key={order.orderNumber}><span><b>{labels[order.status] || order.status}</b><small>Placed {new Date(order.placedAt).toLocaleString()}</small></span><strong>{money(order.totalCents)} →</strong></button>)}</div>}</section></div><Footer simple /></main>;
}
