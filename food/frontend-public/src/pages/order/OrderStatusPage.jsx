import { useCallback, useEffect, useState } from 'react';
import Header from '../../components/Header';
import Footer from '../../components/Footer';
import StatusTimeline from '../../components/order/StatusTimeline';
import { loadOrder } from '../../lib/foodops';

const labels = { PENDING: 'NEW ORDER', CONFIRMED: 'ACCEPTED', PREPARING: 'ACCEPTED', READY: 'READY', COMPLETED: 'COMPLETED', CANCELLED: 'CANCELLED' };

export default function OrderStatusPage() {
  const orderNumber = window.location.pathname.split('/').pop();
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(() => {
    setLoading(true); setError('');
    loadOrder(orderNumber).then(setOrder).catch((requestError) => setError(requestError.message)).finally(() => setLoading(false));
  }, [orderNumber]);
  useEffect(refresh, [refresh]);
  return <main className="order-flow-page"><Header showSignIn={false} /><div className="order-flow-shell"><section className="order-panel status-panel"><b>YOUR ORDER</b><h1>Order status</h1>{error ? <><p className="form-error" role="alert">{error}</p><a className="order-secondary" href="/order/view">FIND YOUR ORDER</a></> : loading && !order ? <p>Loading your order…</p> : order && <><p className="status-label">{labels[order.status]}</p>{['PENDING', 'CONFIRMED'].includes(order.status) && <p>Your order is usually ready in 15–20 minutes.</p>}<div className="panel-rule" /><StatusTimeline current={labels[order.status]} /><div className="status-facts"><div><b>PLACED</b><span>{new Date(order.createdAt).toLocaleString()}</span></div><div><b>PAYMENT</b><span>Pay on Site</span></div><div><b>TOTAL</b><span>${(order.totalCents / 100).toFixed(2)}</span></div></div><div className="status-items"><b>ITEMS</b>{order.items.map((item, index) => <div key={`${item.name}-${index}`}><span>{item.quantity} × {item.name}{item.modifiers?.length ? ` · ${item.modifiers.map((modifier) => modifier.optionName).join(', ')}` : ''}</span><strong>${(item.lineTotalCents / 100).toFixed(2)}</strong></div>)}</div><div className="panel-rule" /><div className="pickup-location"><b>PICKUP LOCATION</b><p>Silk Road Grill at Trucker Heaven<br />8037 Eastgate Blvd, Mt. Juliet, TN 37122</p></div>{order.estimatedReadyAt && <p>Estimated ready: {new Date(order.estimatedReadyAt).toLocaleString()}</p>}<button className="order-secondary" type="button" onClick={refresh} disabled={loading}>{loading ? 'REFRESHING…' : 'REFRESH STATUS'}</button></>}<a className="order-secondary" href="/menu">BACK TO MENU</a></section></div><Footer simple /></main>;
}
