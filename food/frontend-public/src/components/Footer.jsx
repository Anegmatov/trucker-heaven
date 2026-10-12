export default function Footer({ compact = false, simple = false }) {
  if (simple) {
    return (
      <footer className="simple-footer">
        <h2>SILK ROAD GRILL</h2>
        <b>UZBEK &amp; INTERNATIONAL FOOD TRUCK AT TRUCKER HEAVEN</b>
        <p>8037 Eastgate Blvd · Mt. Juliet, TN 37122</p>
      </footer>
    );
  }

  if (compact) {
    return (
      <footer className="home-footer">
        <div className="footer-rule" />
        <div className="home-footer-content">
          <h2>SILK ROAD GRILL</h2>
          <b>Uzbek &amp; International Food Truck at Trucker Heaven</b>
          <p>8037 Eastgate Blvd, Mt. Juliet, TN 37122</p>
        </div>
      </footer>
    );
  }

  return (
    <footer className="menu-footer">
      <div className="footer-rule" />
      <div className="footer-columns">
        <div className="footer-about">
          <div className="footer-lockup">
            <div className="seal"><span>SILK</span><span>ROAD</span></div>
            <div><h2>SILK ROAD GRILL</h2><b>AT TRUCKER HEAVEN</b></div>
          </div>
          <p>Uzbek &amp; International Food Truck at Trucker Heaven.<br />8037 Eastgate Blvd, Mt. Juliet, TN 37122</p>
        </div>
        <div className="footer-links">
          <h3>Quick Links</h3>
          <a href="/menu">View Full Menu</a>
          <a href="/menu">Order Online Now</a>
          <a href="/order/view">View Order</a>
          <a href="#reviews">Customer Reviews</a>
          <a href="#kazan">About the Kazan Process</a>
          <a href="#parking">Trucker Parking Maps</a>
        </div>
        <div className="footer-location">
          <h3>Location &amp; Order</h3>
          <strong><img src="/assets/phone.svg" alt="" />615 571 7612</strong>
          <p><img src="/assets/map-pin.svg" alt="" />8037 Eastgate Blvd<br /><em>Mt. Juliet, TN 37122</em></p>
          <p><img src="/assets/clock.svg" alt="" />Open Daily: 9:00 AM - 10:00 PM</p>
        </div>
      </div>
      <div className="footer-rule" />
      <div className="footer-bottom">
        <p>© 2025 Silk Road Grill. All rights reserved. Premium Terminal Dining Partner at Trucker Heaven Tennessee.</p>
        <div><a href="#privacy">Privacy Policy</a><a href="#terms">Terms of Service</a></div>
      </div>
    </footer>
  );
}
