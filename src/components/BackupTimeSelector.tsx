import type { ChangeEvent } from "react";

/**
 * Compact, browser-independent clock controls.
 * The backend continues to receive local HH:MM (24-hour) timestamps.
 */
interface Props {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}

const HOURS = Array.from({ length: 12 }, (_, i) => i + 1);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);

function padded(number: number): string {
  return String(number).padStart(2, "0");
}

export default function BackupTimeSelector({ value, disabled = false, onChange }: Props) {
  const matched = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  const hour24 = matched ? Number(matched[1]) : 2;
  const minute = matched ? Number(matched[2]) : 0;
  const hour12 = hour24 % 12 || 12;
  const period = hour24 >= 12 ? "PM" : "AM";

  function update(hour: number, minutes: number, meridiem: "AM" | "PM") {
    const nextHour = (hour % 12) + (meridiem === "PM" ? 12 : 0);
    onChange(`${padded(nextHour)}:${padded(minutes)}`);
  }

  function onHourChange(event: ChangeEvent<HTMLSelectElement>) {
    update(Number(event.target.value), minute, period);
  }

  function onMinuteChange(event: ChangeEvent<HTMLSelectElement>) {
    update(hour12, Number(event.target.value), period);
  }

  return (
    <div className="hwb-time-selector" role="group" aria-label="Backup time, Windows local">
      <div className="hwb-time-clock">
        <select className="hwb-time-unit" aria-label="Hour"
          value={hour12} onChange={onHourChange} disabled={disabled}>
          {HOURS.map((hour) => (
            <option key={hour} value={hour}>{padded(hour)}</option>
          ))}
        </select>
        <span className="hwb-time-colon" aria-hidden="true">:</span>
        <select className="hwb-time-unit" aria-label="Minute"
          value={minute} onChange={onMinuteChange} disabled={disabled}>
          {MINUTES.map((minutes) => (
            <option key={minutes} value={minutes}>{padded(minutes)}</option>
          ))}
        </select>
      </div>
      <div className="hwb-time-period" role="group" aria-label="AM or PM">
        {(["AM", "PM"] as const).map((option) => (
          <button key={option} type="button" aria-pressed={period === option}
            className={period === option ? "is-selected" : ""}
            disabled={disabled} onClick={() => update(hour12, minute, option)}>
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}
