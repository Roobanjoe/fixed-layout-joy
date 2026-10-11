import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { FileText, LogOut, Save, UserRound, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { lovable } from "@/integrations/lovable";
import { supabase } from "@/integrations/supabase/client";
import type { Json, Tables } from "@/integrations/supabase/types";

const DOCUMENT_MODES = ["invoice", "quote", "letterpad"] as const;
type DocumentMode = (typeof DOCUMENT_MODES)[number];

const FONT_OPTIONS = [
  { label: "Arial", value: "Arial, sans-serif" },
  { label: "Inter", value: "Inter, sans-serif" },
  { label: "Helvetica", value: "Helvetica, sans-serif" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Times New Roman", value: "'Times New Roman', serif" },
  { label: "Courier New", value: "'Courier New', monospace" },
  { label: "Trebuchet MS", value: "'Trebuchet MS', sans-serif" },
  { label: "Verdana", value: "Verdana, sans-serif" },
  { label: "Garamond", value: "Garamond, serif" },
  { label: "Palatino", value: "'Palatino Linotype', serif" },
] as const;

type ClientFields = { name: string; address: string; phone: string };
type HostCommand =
  | { source: "invoice-host"; type: "settings"; mode: DocumentMode; font: string }
  | { source: "invoice-host"; type: "load-document"; document: Record<string, unknown> }
  | { source: "invoice-host"; type: "get-client" }
  | { source: "invoice-host"; type: "fill-client"; client: ClientFields };
type InvoiceMessage =
  | { source: "invoice-generator"; type: "ready" }
  | {
      source: "invoice-generator";
      type: "document-saved";
      document: Record<string, unknown>;
      mode: DocumentMode;
    }
  | { source: "invoice-generator"; type: "client-data"; client: ClientFields };

type SavedClient = Tables<"saved_clients">;
type InvoiceRecord = Tables<"invoice_records">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDocumentMode(value: unknown): value is DocumentMode {
  return DOCUMENT_MODES.some((mode) => mode === value);
}

function isInvoiceMessage(value: unknown): value is InvoiceMessage {
  if (!isRecord(value) || value["source"] !== "invoice-generator") return false;
  if (value["type"] === "ready") return true;
  if (value["type"] === "document-saved") {
    return isRecord(value["document"]) && isDocumentMode(value["mode"]);
  }
  if (value["type"] === "client-data" && isRecord(value["client"])) {
    return [value["client"]["name"], value["client"]["address"], value["client"]["phone"]].every(
      (field) => typeof field === "string",
    );
  }
  return false;
}

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Invoice Studio — Invoices, Quotes & Letterheads" },
      {
        name: "description",
        content: "Create invoices, quotes, and letterheads, then save your work and clients to your account.",
      },
      { property: "og:title", content: "Invoice Studio — Invoices, Quotes & Letterheads" },
      {
        property: "og:description",
        content: "Create invoices, quotes, and letterheads, then save your work and clients to your account.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: InvoiceStudio,
});

function InvoiceStudio() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const selectedRecordId = useRef<string | null>(null);
  const waitingForClient = useRef(false);
  const [session, setSession] = useState<Session | null>(null);
  const [mode, setMode] = useState<DocumentMode>("invoice");
  const [font, setFont] = useState<string>(FONT_OPTIONS[0].value);
  const [clients, setClients] = useState<SavedClient[]>([]);
  const [records, setRecords] = useState<InvoiceRecord[]>([]);
  const [dialog, setDialog] = useState<"auth" | "history" | null>(null);
  const [clientDialogOpen, setClientDialogOpen] = useState(false);
  const [clientDraft, setClientDraft] = useState<ClientFields>({ name: "", address: "", phone: "" });
  const [savingClient, setSavingClient] = useState(false);
  const [authMode, setAuthMode] = useState<"sign-in" | "create">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const sendToInvoice = useCallback((command: HostCommand) => {
    iframeRef.current?.contentWindow?.postMessage(command, window.location.origin);
  }, []);

  useEffect(() => {
    let alive = true;
    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (error) throw error;
        if (alive) setSession(data.session);
      })
      .catch((error: unknown) => {
        if (alive) setNotice(error instanceof Error ? error.message : "Couldn't check your account.");
      });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      selectedRecordId.current = null;
      if (!nextSession) {
        setClients([]);
        setRecords([]);
      }
    });
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const userId = session?.user.id;
    if (!userId) return;
    let alive = true;
    Promise.all([
      supabase.from("saved_clients").select("*").order("name"),
      supabase.from("invoice_records").select("*").order("updated_at", { ascending: false }),
    ])
      .then(([clientResult, recordResult]) => {
        if (!alive) return;
        if (clientResult.error) throw clientResult.error;
        if (recordResult.error) throw recordResult.error;
        setClients(clientResult.data);
        setRecords(recordResult.data);
      })
      .catch((error: unknown) => {
        if (alive) setNotice(error instanceof Error ? error.message : "Couldn't load saved items.");
      });
    return () => {
      alive = false;
    };
  }, [session?.user.id]);

  const persistDocument = useCallback(
    async (message: Extract<InvoiceMessage, { type: "document-saved" }>) => {
      const userId = session?.user.id;
      if (!userId) {
        setNotice("Sign in to save this document to your account. A local copy was saved in this browser.");
        return;
      }
      const document = message.document;
      const title = [
        typeof document["no"] === "string" ? document["no"] : "",
        typeof document["cn"] === "string" ? document["cn"] : "",
      ]
        .filter(Boolean)
        .join(" · ") || (message.mode === "quote" ? "Quote" : "Untitled document");
      const payload = JSON.parse(JSON.stringify(document)) as Json;
      const existingId = selectedRecordId.current;
      const result = existingId
        ? await supabase
            .from("invoice_records")
            .update({ document_type: message.mode, title, payload })
            .eq("id", existingId)
            .eq("user_id", userId)
            .select()
            .maybeSingle()
        : await supabase
            .from("invoice_records")
            .insert({ user_id: userId, document_type: message.mode, title, payload })
            .select()
            .single();
      if (result.error) {
        setNotice(result.error.message);
        return;
      }
      if (!result.data) {
        selectedRecordId.current = null;
        setNotice("That saved document is no longer available. Save again to create a new copy.");
        return;
      }
      const savedRecord = result.data;
      selectedRecordId.current = savedRecord.id;
      setRecords((current) => [savedRecord, ...current.filter((item) => item.id !== savedRecord.id)]);
      setNotice("Saved to your account.");
    },
    [session?.user.id],
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || event.source !== iframeRef.current?.contentWindow) {
        return;
      }
      if (!isInvoiceMessage(event.data)) return;
      if (event.data.type === "ready") {
        sendToInvoice({ source: "invoice-host", type: "settings", mode, font });
      } else if (event.data.type === "document-saved") {
        void persistDocument(event.data);
      } else if (event.data.type === "client-data" && waitingForClient.current) {
        waitingForClient.current = false;
        setClientDraft(event.data.client);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [font, mode, persistDocument, sendToInvoice, session?.user.id]);

  function changeMode(nextMode: string) {
    if (!isDocumentMode(nextMode)) return;
    setMode(nextMode);
    sendToInvoice({ source: "invoice-host", type: "settings", mode: nextMode, font });
  }

  function changeFont(nextFont: string) {
    if (!FONT_OPTIONS.some((option) => option.value === nextFont)) return;
    setFont(nextFont);
    sendToInvoice({ source: "invoice-host", type: "settings", mode, font: nextFont });
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    try {
      if (authMode === "create") {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        if (!data.session) {
          setNotice("Check your email to finish creating your account.");
        } else {
          setDialog(null);
          setNotice("Your account is ready.");
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        setDialog(null);
        setNotice("Signed in.");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Couldn't complete sign-in.");
    } finally {
      setBusy(false);
    }
  }

  async function signInWithGoogle() {
    setBusy(true);
    setNotice("");
    try {
      const result = await lovable.auth.signInWithOAuth("google", {
        redirect_uri: window.location.origin,
      });
      if (result.error) throw result.error;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Couldn't sign in with Google.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    const { error } = await supabase.auth.signOut();
    setNotice(error ? error.message : "Signed out.");
  }

  async function deleteRecord(recordId: string) {
    if (!session?.user.id) return;
    const { error } = await supabase
      .from("invoice_records")
      .delete()
      .eq("id", recordId)
      .eq("user_id", session.user.id);
    if (error) {
      setNotice(error.message);
      return;
    }
    if (selectedRecordId.current === recordId) selectedRecordId.current = null;
    setRecords((current) => current.filter((record) => record.id !== recordId));
    setNotice("Document deleted.");
  }

  function loadRecord(record: InvoiceRecord) {
    if (!isRecord(record.payload)) return;
    selectedRecordId.current = record.id;
    if (isDocumentMode(record.document_type)) setMode(record.document_type);
    sendToInvoice({
      source: "invoice-host",
      type: "load-document",
      document: record.payload,
    });
    setDialog(null);
  }

  function saveCurrentClient() {
    if (!session?.user.id) {
      setDialog("auth");
      return;
    }
    setClientDraft({ name: "", address: "", phone: "" });
    setClientDialogOpen(true);
    waitingForClient.current = true;
    sendToInvoice({ source: "invoice-host", type: "get-client" });
  }

  async function submitClient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const userId = session?.user.id;
    if (!userId) {
      setClientDialogOpen(false);
      setDialog("auth");
      return;
    }
    setSavingClient(true);
    try {
      const { data, error } = await supabase
        .from("saved_clients")
        .insert({
          user_id: userId,
          name: clientDraft.name.trim(),
          company_address: clientDraft.address.trim(),
          contact_number: clientDraft.phone.trim(),
        })
        .select()
        .single();
      if (error) throw error;
      setClients((current) => [...current, data].sort((a, b) => a.name.localeCompare(b.name)));
      setClientDialogOpen(false);
      setNotice("Client saved to your account. Choose it from the saved-client list.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Couldn't save this client.");
    } finally {
      setSavingClient(false);
    }
  }

  function chooseClient(clientId: string) {
    const client = clients.find((entry) => entry.id === clientId);
    if (!client) return;
    sendToInvoice({
      source: "invoice-host",
      type: "fill-client",
      client: { name: client.name, address: client.company_address, phone: client.contact_number },
    });
    setNotice(`${client.name} added to this document.`);
  }

  const accountName = session?.user.email?.split("@")[0] ?? "Account";

  return (
    <main className="dark flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="z-10 shrink-0 border-b border-border bg-card text-card-foreground">
        <div className="flex min-h-12 flex-wrap items-center justify-between gap-2 px-3 py-2 sm:px-4">
          <div className="flex items-center gap-2">
            <FileText className="size-4 text-primary" aria-hidden="true" />
            <span className="text-sm font-semibold">Invoice Studio</span>
          </div>
          <div className="flex items-center gap-2">
            {session ? (
              <>
                <Button variant="ghost" size="sm" onClick={() => setDialog("history")}>
                  <Users aria-hidden="true" /> History <span className="text-muted-foreground">{records.length}</span>
                </Button>
                <span className="hidden max-w-32 truncate text-xs text-muted-foreground sm:inline">{accountName}</span>
                <Button variant="ghost" size="icon" title="Sign out" aria-label="Sign out" onClick={() => void signOut()}>
                  <LogOut aria-hidden="true" />
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => setDialog("auth")}>
                <UserRound aria-hidden="true" /> Sign in
              </Button>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-border/70 px-3 py-2 sm:px-4">
          <Select value={mode} onValueChange={changeMode}>
            <SelectTrigger className="h-8 w-[132px] bg-background text-xs" aria-label="Document type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="invoice">Invoice</SelectItem>
              <SelectItem value="quote">Quote</SelectItem>
              <SelectItem value="letterpad">Letterpad</SelectItem>
            </SelectContent>
          </Select>
          <Select value={font} onValueChange={changeFont}>
            <SelectTrigger className="h-8 w-[150px] bg-background text-xs" aria-label="Document font">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FONT_OPTIONS.map((option) => (
                <SelectItem key={option.label} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            onValueChange={chooseClient}
            disabled={!session || clients.length === 0}
          >
            <SelectTrigger className="h-8 min-w-[142px] flex-1 bg-background text-xs sm:flex-none sm:w-[190px]" aria-label="Select a saved client">
              <SelectValue placeholder={!session ? "Sign in for clients" : clients.length ? "Choose saved client" : "No saved clients yet"} />
            </SelectTrigger>
            <SelectContent>
              {clients.map((client) => (
                <SelectItem key={client.id} value={client.id}>
                  {client.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={saveCurrentClient}>
            <Save aria-hidden="true" /> Save client
          </Button>
        </div>
        {notice && (
          <p className="border-t border-border/70 px-3 py-1 text-xs text-muted-foreground sm:px-4" role="status">
            {notice}
          </p>
        )}
      </header>

      <iframe
        ref={iframeRef}
        className="invoice-original min-h-0 flex-1 bg-white"
        src="/invoice-generator.html"
        title="Invoice generator"
        onLoad={() => sendToInvoice({ source: "invoice-host", type: "settings", mode, font })}
      />

      <Dialog open={clientDialogOpen} onOpenChange={(open) => {
        setClientDialogOpen(open);
        if (!open) waitingForClient.current = false;
      }}>
        <DialogContent className="dark border-border bg-card text-card-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Save client</DialogTitle>
            <DialogDescription>Review the details, then save them for your next invoice.</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={(event) => void submitClient(event)}>
            <div className="space-y-2">
              <Label htmlFor="client-name">Client name</Label>
              <Input id="client-name" autoComplete="organization" required value={clientDraft.name} onChange={(event) => setClientDraft((current) => ({ ...current, name: event.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="client-address">Company / address</Label>
              <Input id="client-address" autoComplete="street-address" value={clientDraft.address} onChange={(event) => setClientDraft((current) => ({ ...current, address: event.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="client-phone">Contact number</Label>
              <Input id="client-phone" type="tel" autoComplete="tel" value={clientDraft.phone} onChange={(event) => setClientDraft((current) => ({ ...current, phone: event.target.value }))} />
            </div>
            <Button className="w-full" type="submit" disabled={savingClient}>
              {savingClient ? "Saving…" : "Save client"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "auth"} onOpenChange={(open) => setDialog(open ? "auth" : null)}>
        <DialogContent className="dark border-border bg-card text-card-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{authMode === "sign-in" ? "Sign in to Invoice Studio" : "Create your account"}</DialogTitle>
            <DialogDescription>Save invoices, quotes, and client details to your account.</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={(event) => void submitAuth(event)}>
            <div className="space-y-2">
              <Label htmlFor="account-email">Email</Label>
              <Input id="account-email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="account-password">Password</Label>
              <Input id="account-password" type="password" autoComplete={authMode === "sign-in" ? "current-password" : "new-password"} minLength={6} required value={password} onChange={(event) => setPassword(event.target.value)} />
            </div>
            <Button className="w-full" type="submit" disabled={busy}>
              {busy ? "Please wait…" : authMode === "sign-in" ? "Sign in" : "Create account"}
            </Button>
          </form>
          <Button variant="outline" disabled={busy} onClick={() => void signInWithGoogle()}>
            Continue with Google
          </Button>
          <Button variant="link" className="h-auto p-0" onClick={() => setAuthMode(authMode === "sign-in" ? "create" : "sign-in")}>
            {authMode === "sign-in" ? "Create an account" : "I already have an account"}
          </Button>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "history"} onOpenChange={(open) => setDialog(open ? "history" : null)}>
        <DialogContent className="dark max-h-[80dvh] overflow-y-auto border-border bg-card text-card-foreground sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Saved documents</DialogTitle>
            <DialogDescription>Invoices, quotes, and letterheads saved to your account.</DialogDescription>
          </DialogHeader>
          {records.length === 0 ? (
            <p className="py-5 text-sm text-muted-foreground">No saved documents yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {records.map((record) => (
                <li key={record.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{record.title || "Untitled document"}</p>
                    <p className="text-xs capitalize text-muted-foreground">
                      {record.document_type} · {new Date(record.updated_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button variant="outline" size="sm" onClick={() => loadRecord(record)}>Open</Button>
                    <Button variant="ghost" size="sm" onClick={() => void deleteRecord(record.id)}>Delete</Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </main>
  );
}