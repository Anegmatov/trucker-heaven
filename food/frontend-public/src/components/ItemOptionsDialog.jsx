import { useState } from 'react';

const formatPrice = (cents) => `$${(cents / 100).toFixed(2)}`;

export default function ItemOptionsDialog({ item, onClose, onConfirm }) {
  const [selected, setSelected] = useState({});
  const [error, setError] = useState('');
  const choose = (group, optionId, checked) => setSelected((current) => {
    const currentIds = current[group.id] || [];
    const nextIds = group.maximumSelections === 1
      ? [optionId]
      : checked ? [...currentIds, optionId].slice(0, group.maximumSelections) : currentIds.filter((id) => id !== optionId);
    return { ...current, [group.id]: nextIds };
  });
  const submit = (event) => {
    event.preventDefault();
    for (const group of item.modifierGroups) {
      const count = (selected[group.id] || []).length;
      if (count < group.minimumSelections || count > group.maximumSelections) {
        setError(`Choose ${group.minimumSelections === group.maximumSelections ? group.minimumSelections : `${group.minimumSelections}–${group.maximumSelections}`} for ${group.name}.`);
        return;
      }
    }
    const optionIds = Object.values(selected).flat();
    const modifiers = item.modifierGroups.flatMap((group) => group.options
      .filter((option) => optionIds.includes(option.id))
      .map((option) => ({ groupName: group.name, optionName: option.name, priceDeltaCents: option.priceDeltaCents })));
    onConfirm(item, { modifierOptionIds: optionIds, modifiers });
  };

  return <div className="item-options-layer"><button className="item-options-backdrop" type="button" onClick={onClose} aria-label="Close item options" /><form className="item-options-dialog" role="dialog" aria-modal="true" aria-labelledby="item-options-title" onSubmit={submit}><header><div><b>CUSTOMIZE</b><h2 id="item-options-title">{item.name}</h2></div><button type="button" onClick={onClose} aria-label="Close item options">×</button></header>{item.modifierGroups.map((group) => <fieldset key={group.id}><legend>{group.name}<small>{group.minimumSelections ? `Choose ${group.minimumSelections}${group.maximumSelections !== group.minimumSelections ? `–${group.maximumSelections}` : ''}` : `Up to ${group.maximumSelections}`}</small></legend>{group.options.map((option) => { const checked = (selected[group.id] || []).includes(option.id); return <label key={option.id}><input type={group.maximumSelections === 1 ? 'radio' : 'checkbox'} name={`modifier-${group.id}`} checked={checked} onChange={(event) => choose(group, option.id, event.target.checked)} /><span>{option.name}</span><strong>{option.priceDeltaCents ? `+${formatPrice(option.priceDeltaCents)}` : 'Included'}</strong></label>; })}</fieldset>)}{error && <p className="form-error" role="alert">{error}</p>}<button className="order-primary" type="submit">ADD TO CART</button></form></div>;
}
