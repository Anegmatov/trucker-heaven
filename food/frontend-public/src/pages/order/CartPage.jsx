import Header from '../../components/Header';
import Footer from '../../components/Footer';
import CartPanel from '../../components/order/CartPanel';

export default function CartPage() {
  return <main className="order-flow-page"><Header showSignIn={false} /><div className="order-flow-shell"><CartPanel /></div><Footer simple /></main>;
}
