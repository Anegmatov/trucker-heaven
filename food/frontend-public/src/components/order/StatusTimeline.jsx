export const ORDER_STATUSES = ['NEW ORDER', 'ACCEPTED', 'READY', 'COMPLETED', 'CANCELLED'];

export default function StatusTimeline({ current = 'RECEIVED' }) {
  return (
    <div className="status-timeline">
      {ORDER_STATUSES.map((status) => <div className={`${status === current ? 'current' : ''} ${status === 'CANCELLED' ? 'alternate' : ''}`} key={status}><i /><span>{status}</span>{status === current && <b>CURRENT</b>}</div>)}
    </div>
  );
}
