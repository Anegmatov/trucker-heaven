import { createContext, useContext, useEffect, useMemo, useState } from 'react';

const CART_KEY = 'silk-road-grill-cart-v1';
const DETAILS_KEY = 'silk-road-grill-order-details-v1';
const CartContext = createContext(null);

const readStored = (key, fallback) => {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

const itemId = (item, optionIds = []) => `${item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}:${[...optionIds].sort().join('-')}`;
export const priceNumber = (price) => Number(String(price).replace(/[^0-9.]/g, '')) || 0;

export function CartProvider({ children }) {
  const [lines, setLines] = useState(() => readStored(CART_KEY, []));
  const [orderDetails, setOrderDetailsState] = useState(() => readStored(DETAILS_KEY, {
    fullName: '', phone: '', email: '', method: 'Pickup / Order Ahead', pickupTime: '', orderNotes: '',
  }));

  useEffect(() => { localStorage.setItem(CART_KEY, JSON.stringify(lines)); }, [lines]);
  useEffect(() => { localStorage.setItem(DETAILS_KEY, JSON.stringify(orderDetails)); }, [orderDetails]);

  const addItem = (item, options = {}) => {
    const modifierOptionIds = options.modifierOptionIds || [];
    const id = itemId(item, modifierOptionIds);
    const modifierPrice = (options.modifiers || []).reduce((sum, modifier) => sum + (modifier.priceDeltaCents || 0), 0) / 100;
    setLines((current) => {
      const index = current.findIndex((line) => line.id === id && line.notes === (options.notes || ''));
      if (index < 0) return [...current, {
        id, menuItemId: item.menuItemId || item.id, name: item.name, description: item.description, image: item.image || '', price: item.price,
        unitPrice: priceNumber(item.price) + modifierPrice, quantity: options.quantity || 1, notes: options.notes || '',
        modifiers: options.modifiers || [], modifierOptionIds, available: item.available !== false,
      }];
      return current.map((line, lineIndex) => lineIndex === index ? { ...line, quantity: line.quantity + (options.quantity || 1) } : line);
    });
  };
  const setQuantity = (id, quantity) => setLines((current) => quantity <= 0 ? current.filter((line) => line.id !== id) : current.map((line) => line.id === id ? { ...line, quantity } : line));
  const removeItem = (id) => setLines((current) => current.filter((line) => line.id !== id));
  const updateNotes = (id, notes) => setLines((current) => current.map((line) => line.id === id ? { ...line, notes } : line));
  const clearCart = () => setLines([]);
  const setOrderDetails = (details) => {
    const next = { ...orderDetails, ...details };
    localStorage.setItem(DETAILS_KEY, JSON.stringify(next));
    setOrderDetailsState(next);
  };
  const subtotal = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0);

  const value = useMemo(() => ({ lines, addItem, setQuantity, removeItem, updateNotes, clearCart, subtotal, itemCount, orderDetails, setOrderDetails }), [lines, subtotal, itemCount, orderDetails]);
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const value = useContext(CartContext);
  if (!value) throw new Error('useCart must be used inside CartProvider');
  return value;
}
