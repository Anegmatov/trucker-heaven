import { useEffect, useRef, useState } from 'react';
import { useCart } from '../state/cart/CartContext';

export default function Header({ showSignIn = true }) {
  const { itemCount } = useCart();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuButtonRef = useRef(null);
  const closeMenu = () => setIsMenuOpen(false);

  useEffect(() => {
    if (!isMenuOpen) return undefined;
    const handleEscape = (event) => {
      if (event.key === 'Escape') closeMenu();
    };
    document.body.classList.add('mobile-nav-open');
    window.addEventListener('keydown', handleEscape);
    return () => {
      document.body.classList.remove('mobile-nav-open');
      window.removeEventListener('keydown', handleEscape);
      menuButtonRef.current?.focus();
    };
  }, [isMenuOpen]);

  return (
    <>
      <header className="global-header">
        <a className="header-brand" href="/">
          <img src="/assets/silk-road-seal.jpg" alt="" />
          <span>SILK ROAD GRILL</span>
        </a>
        <nav className="header-nav" aria-label="Primary navigation">
          <a href="/menu">Menu</a>
          <a href="/catering">Catering</a>
          <a href="/featured">Featured</a>
          <a href="/about">About Us</a>
        </nav>
        <div className="header-actions">
          <a className="view-order-link" href="/order/view">View Order</a>
          <a className="cart-link" href="/order/cart" aria-label={`Cart, ${itemCount} item${itemCount === 1 ? '' : 's'}`}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h2l2.1 10.1a2 2 0 0 0 2 1.6h7.8a2 2 0 0 0 1.9-1.4L20 8H7" /><circle cx="10" cy="20" r="1.25" /><circle cx="17" cy="20" r="1.25" /></svg>
            <span key={itemCount} className={`cart-count${itemCount ? ' has-items' : ''}`} aria-hidden="true">{itemCount}</span>
          </a>
          {showSignIn && <a className="sign-in" href="#sign-in">Sign In</a>}
          <a className="order-button squared" href="/menu">ORDER ONLINE →</a>
          <button ref={menuButtonRef} className="mobile-nav-toggle" type="button" aria-label="Open menu" aria-expanded={isMenuOpen} aria-controls="mobile-navigation" onClick={() => setIsMenuOpen(true)}>
            <span /><span /><span />
          </button>
        </div>
      </header>
      {isMenuOpen && <div className="mobile-nav-layer">
        <button className="mobile-nav-backdrop" type="button" aria-label="Close menu" onClick={closeMenu} />
        <aside className="mobile-nav-panel" id="mobile-navigation" aria-label="Mobile navigation">
          <div className="mobile-nav-heading"><span>MENU</span><button type="button" aria-label="Close menu" onClick={closeMenu}>×</button></div>
          <nav>
            <a href="/menu" onClick={closeMenu}>Menu</a>
            <a href="/catering" onClick={closeMenu}>Catering</a>
            <a href="/featured" onClick={closeMenu}>Featured</a>
            <a href="/about" onClick={closeMenu}>About Us</a>
            <a href="/order/view" onClick={closeMenu}>View Order</a>
          </nav>
          <a className="mobile-nav-cart" href="/order/cart" onClick={closeMenu}>Cart <span>{itemCount}</span></a>
          <a className="mobile-nav-order" href="/menu" onClick={closeMenu}>ORDER ONLINE →</a>
        </aside>
      </div>}
    </>
  );
}
