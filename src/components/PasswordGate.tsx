import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Lock } from "lucide-react";

const STORAGE_KEY = "m3u8_dashboard_auth";
const PASS_HASH = "Qm9hbmVyZ2VzMTIq"; // base64 of the password

function encode(val: string) {
  return btoa(val);
}

export default function PasswordGate({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored === PASS_HASH) setAuthed(true);
    setLoading(false);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (encode(password) === PASS_HASH) {
      sessionStorage.setItem(STORAGE_KEY, PASS_HASH);
      setAuthed(true);
      setError(false);
    } else {
      setError(true);
    }
  };

  if (loading) return null;
  if (authed) return <>{children}</>;

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
        <div className="flex flex-col items-center gap-2 mb-6">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
            <Lock className="w-6 h-6 text-primary" />
          </div>
          <h1 className="text-xl font-semibold text-foreground">Acceso restringido</h1>
          <p className="text-sm text-muted-foreground">Ingrese la contraseña para continuar</p>
        </div>
        <Input
          type="password"
          placeholder="Contraseña"
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError(false); }}
          className={error ? "border-red-500" : ""}
          autoFocus
        />
        {error && <p className="text-sm text-red-500">Contraseña incorrecta</p>}
        <Button type="submit" className="w-full">Ingresar</Button>
      </form>
    </div>
  );
}
