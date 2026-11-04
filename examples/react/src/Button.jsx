export function Button({ children, onClick }) {
  return <button className="btn" onClick={onClick}>{children}</button>;
}
