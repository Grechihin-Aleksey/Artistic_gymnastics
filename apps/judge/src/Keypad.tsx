const KEYS = ["7", "8", "9", "4", "5", "6", "1", "2", "3", ".", "0", "⌫"];

export function Keypad({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const press = (key: string) => {
    if (key === "⌫") return onChange(value.slice(0, -1));
    if (key === "." && (value.includes(".") || value === "")) return;
    if (value.length >= 6) return;
    onChange(value + key);
  };
  return (
    <div className="keypad">
      {KEYS.map((key) => (
        <button key={key} type="button" className="key" onClick={() => press(key)}>
          {key}
        </button>
      ))}
    </div>
  );
}
