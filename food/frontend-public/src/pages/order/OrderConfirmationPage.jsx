import Header from '../../components/Header';
import Footer from '../../components/Footer';

export default function OrderConfirmationPage() {
  const orderId = window.location.pathname.split('/').pop();
  return <main className="order-flow-page"><Header showSignIn={false} /><div className="order-flow-shell"><section className="order-panel confirmation-panel"><i>✓</i><b>ORDER RECEIVED</b><h1>We’ve got your order.</h1><p>Your order has been sent to Silk Road Grill.</p><div className="confirmation-facts"><span><b>PAYMENT</b>Pay on Site</span><span><b>READY</b>Usually 15–20 minutes</span></div><div className="panel-rule short" /><strong>PICKUP · SILK ROAD GRILL AT TRUCKER HEAVEN<br />8037 Eastgate Blvd · Mt. Juliet, TN 37122</strong><a className="order-primary" href={`/order/status/${orderId}`}>VIEW ORDER</a><a className="order-secondary" href="/menu">BACK TO MENU</a></section></div><Footer simple /></main>;
}
