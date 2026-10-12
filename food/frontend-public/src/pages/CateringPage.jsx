import { useEffect, useRef, useState } from 'react';
import Header from '../components/Header';
import Footer from '../components/Footer';
import FormField from '../components/forms/FormField';
import { submitCateringRequest } from '../lib/foodops';

const initialForm = {
  fullName: '', phone: '', email: '', company: '', eventDate: '', pickupTime: '', guestCount: '',
  orderType: 'Catering', interestedIn: ['Not Sure Yet'], specialNotes: '', contactMethod: 'Phone',
};
const interests = ['Plov', 'Samsa', 'Shawarma', 'Mixed Order', 'Not Sure Yet'];
const orderTypes = ['Catering', 'Large Pickup Order', 'Event Food Request'];

function CateringVideo({ src, label }) {
  const videoRef = useRef(null);
  const [reducedMotion, setReducedMotion] = useState(() => (
    typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ));

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => setReducedMotion(preference.matches);
    preference.addEventListener?.('change', updatePreference);
    return () => preference.removeEventListener?.('change', updatePreference);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    if (reducedMotion) {
      video.pause();
      return undefined;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) video.play().catch(() => {});
      else video.pause();
    }, { threshold: 0.25 });
    observer.observe(video);
    return () => observer.disconnect();
  }, [reducedMotion]);

  return (
    <figure className="catering-story-media">
      <video ref={videoRef} src={src} muted playsInline loop preload="metadata" aria-label={label} />
    </figure>
  );
}

export default function CateringPage() {
  const [form, setForm] = useState(initialForm);
  const [errors, setErrors] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const update = (name, value) => setForm((current) => ({ ...current, [name]: value }));
  const toggleInterest = (interest) => setForm((current) => ({ ...current, interestedIn: current.interestedIn.includes(interest) ? current.interestedIn.filter((item) => item !== interest) : [...current.interestedIn, interest] }));

  useEffect(() => {
    const scrollToRequest = () => {
      if (window.location.hash !== '#catering-request') return;
      window.requestAnimationFrame(() => {
        document.getElementById('catering-request')?.scrollIntoView({ block: 'start' });
      });
    };
    scrollToRequest();
    window.addEventListener('hashchange', scrollToRequest);
    return () => window.removeEventListener('hashchange', scrollToRequest);
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();
    const nextErrors = {};
    if (!form.fullName.trim()) nextErrors.fullName = 'Full name is required.';
    if (!form.phone.trim()) nextErrors.phone = 'Phone number is required.';
    if (!/^\S+@\S+\.\S+$/.test(form.email)) nextErrors.email = 'Enter a valid email address.';
    if (!form.eventDate) nextErrors.eventDate = 'Choose an event date.';
    if (!form.pickupTime) nextErrors.pickupTime = 'Choose a pickup time.';
    if (!form.guestCount || Number(form.guestCount) < 1) nextErrors.guestCount = 'Enter an estimated guest count.';
    if (!form.interestedIn.length) nextErrors.interestedIn = 'Select at least one option.';
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    setSubmitting(true); setSubmitError('');
    try {
      await submitCateringRequest({ fullName: form.fullName, phone: form.phone, email: form.email, company: form.company,
        eventDate: form.eventDate, pickupTime: form.pickupTime, guestCount: Number(form.guestCount),
        orderType: 'PICKUP', interestedIn: form.interestedIn, specialNotes: form.specialNotes,
        preferredContactMethod: form.contactMethod.toUpperCase() });
      setSubmitted(true);
    } catch (error) { setSubmitError(error.message); } finally { setSubmitting(false); }
  };

  return (
    <main className="editorial-page catering-page">
      <Header showSignIn={false} />
      <section className="editorial-dark-hero catering-hero">
        <div><b>CATERING &amp; LARGE ORDERS</b><h1>Feed your crew.</h1><i /><p>From driver groups to company lunches and large pickup orders, Silk Road Grill can prepare food for more than one table.</p><a className="figma-button" href="#catering-request">REQUEST CATERING</a></div>
        <img src="/assets/catering-spread.jpg" alt="A shared spread of Uzbek dishes prepared for a group" />
      </section>
      <section className="use-cases"><div className="use-case-grid">
        {[
          ['01', 'Fleet & company lunches', 'Bring a team together without leaving the Trucker Heaven property.'],
          ['02', 'Driver groups', 'Simple large-order pickup for drivers traveling together.'],
          ['03', 'Trucker Heaven events', 'Food service for on-site gatherings and property events.'],
          ['04', 'Custom large orders', 'Talk to us about a larger pickup order or catering request.'],
        ].map(([number, title, copy]) => <article key={number}><b>{number}</b><h3>{title}</h3><p>{copy}</p></article>)}
      </div><div className="catering-story">
        <div className="catering-story-copy"><i aria-hidden="true" /><h2>Made for the whole table</h2><p>From hearty family-style trays to individual favorites, our catering options are built for groups of all sizes. Perfect for company lunches, team meals, and driver groups passing through Trucker Heaven.</p><ul><li>Generous portions &amp; shareable trays</li><li>Easy pickup at Trucker Heaven</li><li>Fresh, authentic Uzbek &amp; international flavors</li></ul></div>
        <CateringVideo src="/assets/silk-road-gathering-01.mp4" label="Fresh food prepared for a group" />
      </div><div className="catering-story reverse">
        <CateringVideo src="/assets/silk-road-gathering-02.mp4" label="Silk Road Grill at Trucker Heaven" />
        <div className="catering-story-copy"><i aria-hidden="true" /><h2>A stop worth sharing</h2><p>Hosting an event at Trucker Heaven? We’ve got you. From driver meetups to community events, we’ll help keep everyone well-fed with unforgettable food and reliable service.</p><ul><li>On-site gatherings &amp; event support</li><li>Flexible menu &amp; order options</li><li>Local service. Real hospitality.</li></ul></div>
      </div></section>
      <section className="catering-form-section" id="catering-request">
        <header className="figma-section-header"><b>CATERING REQUEST</b><h2>Tell us what you need.</h2><i /><p>Let us know your group size, preferred date and what kind of order you're planning. We'll follow up with details, availability, and pricing.</p></header>
        {submitted ? <div className="catering-success" role="status"><b>REQUEST RECEIVED</b><h3>Thank you, {form.fullName}.</h3><p>Your catering request has been sent to Silk Road Grill. We’ll follow up with availability, details, and pricing.</p><button type="button" className="figma-button" onClick={() => setSubmitted(false)}>EDIT REQUEST</button></div> :
        <form className="catering-form" onSubmit={handleSubmit} noValidate>
          <div className="form-two-column">
            <FormField label="FULL NAME" value={form.fullName} onChange={(e) => update('fullName', e.target.value)} placeholder="Enter your full name" error={errors.fullName} />
            <FormField label="PHONE NUMBER" value={form.phone} onChange={(e) => update('phone', e.target.value)} placeholder="(555) 000-0000" error={errors.phone} inputMode="tel" />
            <FormField label="EMAIL" value={form.email} onChange={(e) => update('email', e.target.value)} placeholder="name@example.com" error={errors.email} type="email" />
            <FormField label="COMPANY / ORGANIZATION (optional)" value={form.company} onChange={(e) => update('company', e.target.value)} placeholder="Enter company name" />
            <FormField label="EVENT DATE" value={form.eventDate} onChange={(e) => update('eventDate', e.target.value)} error={errors.eventDate} type="date" />
            <FormField label="PICKUP TIME" value={form.pickupTime} onChange={(e) => update('pickupTime', e.target.value)} error={errors.pickupTime} type="time" />
          </div>
          <FormField className="guest-field" label="ESTIMATED GUEST COUNT" value={form.guestCount} onChange={(e) => update('guestCount', e.target.value)} placeholder="Enter number of guests" error={errors.guestCount} type="number" min="1" />
          <div className="form-divider" />
          <fieldset className="choice-group"><legend>ORDER TYPE</legend>{orderTypes.map((option) => <label key={option}><input type="radio" name="orderType" checked={form.orderType === option} onChange={() => update('orderType', option)} /><span>{option}</span></label>)}</fieldset>
          <fieldset className="choice-group"><legend>INTERESTED IN</legend>{interests.map((option) => <label key={option}><input type="checkbox" checked={form.interestedIn.includes(option)} onChange={() => toggleInterest(option)} /><span>{option}</span></label>)}{errors.interestedIn && <small>{errors.interestedIn}</small>}</fieldset>
          <FormField label="SPECIAL NOTES" as="textarea" value={form.specialNotes} onChange={(e) => update('specialNotes', e.target.value)} placeholder="Add any dietary restrictions or special requests..." />
          <fieldset className="choice-group contact-choice"><legend>PREFERRED CONTACT METHOD</legend>{['Phone', 'Email'].map((option) => <label key={option}><input type="radio" name="contactMethod" checked={form.contactMethod === option} onChange={() => update('contactMethod', option)} /><span>{option}</span></label>)}</fieldset>
          <div className="form-divider" />
          {submitError && <p className="form-error" role="alert">{submitError}</p>}<div className="form-submit"><button type="submit" className="pill-button" disabled={submitting}>{submitting ? 'SENDING REQUEST…' : 'SUBMIT CATERING REQUEST'}</button><p>We'll review your request and follow up with availability, details, and pricing.</p></div>
        </form>}
      </section>
      <Footer simple />
    </main>
  );
}
