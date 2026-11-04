import { useState } from 'react';
import { Button } from './Button.jsx';

const links = [
  { label: 'Read the essay', href: '/essay' },
  { label: 'See the work', href: '/work' },
];

export default function App() {
  const [count, setCount] = useState(0);
  const name = 'friend';
  return (
    <main style={{ fontFamily: 'Georgia, serif', maxWidth: 560, margin: '48px auto', lineHeight: 1.5 }}>
      <h1>Small tools for shared rooms</h1>
      <p>
        Hello {name}, this paragraph is written straight in the JSX
        and wraps across a couple of lines.
      </p>
      <nav>
        {links.map((l) => (
          <a key={l.href} href={l.href} style={{ marginRight: 12 }}>{l.label}</a>
        ))}
      </nav>
      <p>
        <Button onClick={() => setCount(count + 1)}>Join the waitlist</Button> <span>{count} joined</span>
      </p>
    </main>
  );
}
