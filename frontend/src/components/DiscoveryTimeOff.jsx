import { useState } from 'react';
import Button from './Button.jsx';
const displayDate = value => new Intl.DateTimeFormat('en-US', { month:'short', day:'numeric', year:'numeric', timeZone:'UTC' }).format(new Date(`${value}T12:00:00Z`));
export default function DiscoveryTimeOff({ value = [], onChange }) {
  const [startDate,setStartDate]=useState('');
  const [endDate,setEndDate]=useState('');
  const [allDay,setAllDay]=useState(true);
  const [startTime,setStartTime]=useState('09:00');
  const [endTime,setEndTime]=useState('17:00');
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  const add = () => {
    setMessage('');setError('');
    if (!startDate || !endDate || endDate < startDate || (!allDay && (!startTime || !endTime || `${endDate}T${endTime}` <= `${startDate}T${startTime}`))) { setError('Choose a valid date range with an end after the start.'); return; }
    if (value.length >= 100) { setError('Remove an old period before adding more time off.'); return; }
    onChange([...value,{startDate,endDate,allDay,startTime:allDay?'00:00':startTime,endTime:allDay?'00:00':endTime}]);
    setMessage('Time off added. Save discovery call settings to apply it.');setStartDate('');setEndDate('');
  };
  return <fieldset className="public-admin__time-off"><legend>Time off</legend>
    <p>Block a day, a vacation, or a few hours. Times use your connected calendar’s time zone.</p>
    <div className="public-admin__time-off-fields">
      <label>From<input type="date" value={startDate} onChange={e=>{setStartDate(e.target.value);if(!endDate||endDate<e.target.value)setEndDate(e.target.value);}} /></label>
      <label>Through<input type="date" min={startDate} value={endDate} onChange={e=>setEndDate(e.target.value)} /></label>
      <label className="website-toggle"><input type="checkbox" checked={allDay} onChange={e=>setAllDay(e.target.checked)} /><span>All day</span></label>
      {!allDay&&<><label>Start time<input type="time" value={startTime} onChange={e=>setStartTime(e.target.value)} /></label><label>End time<input type="time" value={endTime} onChange={e=>setEndTime(e.target.value)} /></label></>}
    </div>
    <Button type="button" variant="outline" onClick={add}>Add time off</Button>
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    {value.length ? <ul className="public-admin__time-off-list">{value.map((row,index)=><li key={`${row.startDate}-${index}`}><span><strong>{displayDate(row.startDate)}{row.endDate!==row.startDate?` – ${displayDate(row.endDate)}`:''}</strong><small>{row.allDay?'All day':`${row.startTime} – ${row.endTime}`}</small></span><Button type="button" variant="outline" aria-label={`Remove time off ${row.startDate}`} onClick={()=>{onChange(value.filter((_,i)=>i!==index));setMessage('Time off removed. Save discovery call settings to apply it.');}}>Remove</Button></li>)}</ul>:<p className="public-admin__time-off-empty">No time off added.</p>}
    <small>Existing appointments are not canceled. Google Calendar busy events also remain unavailable.</small>
  </fieldset>;
}
