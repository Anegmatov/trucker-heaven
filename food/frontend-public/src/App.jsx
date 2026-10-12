import HomePage from './pages/HomePage';
import MenuPage from './pages/MenuPage';
import CateringPage from './pages/CateringPage';
import FeaturedPage from './pages/FeaturedPage';
import AboutPage from './pages/AboutPage';
import CartPage from './pages/order/CartPage';
import OrderDetailsPage from './pages/order/OrderDetailsPage';
import ReviewOrderPage from './pages/order/ReviewOrderPage';
import OrderConfirmationPage from './pages/order/OrderConfirmationPage';
import OrderStatusPage from './pages/order/OrderStatusPage';
import OrderLookupPage from './pages/order/OrderLookupPage';
import SeoMetadata from './components/SeoMetadata';

export default function App() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  let page = <HomePage />;
  if (path === '/menu') page = <MenuPage />;
  else if (path === '/catering') page = <CateringPage />;
  else if (path === '/featured') page = <FeaturedPage />;
  else if (path === '/about') page = <AboutPage />;
  if (path === '/order') {
    window.history.replaceState({}, '', '/menu');
    page = <MenuPage />;
  }
  else if (path === '/order/cart') page = <CartPage />;
  else if (path === '/order/details') page = <OrderDetailsPage />;
  else if (path === '/order/review') page = <ReviewOrderPage />;
  else if (/^\/order\/confirmation\/[^/]+$/.test(path)) page = <OrderConfirmationPage />;
  else if (/^\/order\/status\/[^/]+$/.test(path)) page = <OrderStatusPage />;
  else if (path === '/order/view') page = <OrderLookupPage />;

  return <><SeoMetadata path={path} />{page}</>;
}
