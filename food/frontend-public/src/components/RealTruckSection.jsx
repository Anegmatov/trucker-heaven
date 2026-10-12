export default function RealTruckSection() {
  return (
    <section className="real-truck-section" id="real-truck" aria-labelledby="real-truck-title">
      <div className="real-truck-copy">
        <b>SILK ROAD GRILL · MT. JULIET, TENNESSEE</b>
        <i aria-hidden="true" />
        <h2 id="real-truck-title">A food truck on I-40.</h2>
        <p>Uzbek and international food served from our food truck at Trucker Heaven. Order ahead, pick it up during your stop, and take it back on the road.</p>
      </div>

      <figure className="real-truck-media">
        <img src="/assets/silk-road-food-truck-patio.png" alt="Silk Road Grill food truck and outdoor patio at Trucker Heaven" />
      </figure>

      <div className="real-truck-details">
        <p className="real-truck-services">ORDER AHEAD • PICKUP • OUTDOOR SEATING</p>
        <p className="real-truck-address">8037 Eastgate Blvd, Mt. Juliet, TN 37122</p>
        <div className="real-truck-actions">
          <a className="order-button squared" href="/menu">ORDER ONLINE</a>
          <a className="real-truck-directions" href="https://www.google.com/maps/search/?api=1&amp;query=8037+Eastgate+Blvd+Mt.+Juliet+TN+37122">GET DIRECTIONS ↗</a>
        </div>
      </div>
    </section>
  );
}
