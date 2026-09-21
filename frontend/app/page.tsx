"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowUp,
  ArrowUpRight,
  ArrowRight,
  Check,
  ChevronDown,
  Code2,
  Copy,
  Globe2,
  KeyRound,
  Layers,
  LogOut,
  Menu,
  MessageSquare,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Ticket,
  Users,
  X,
  Zap,
  Clock,
  CheckCircle2,
  Loader2,
  HandHeart,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
type User = { id: string; name: string; email: string };
type Offer = {
  id: string;
  lender_id: string;
  title: string;
  description: string;
  token_limit: number;
  duration_minutes: number;
  expires_at: string;
  active: boolean;
  lender_name: string;
  request_status?: string;
};
type Grant = {
  id: string;
  offer_id: string;
  title: string;
  lender_name: string;
  borrower_name: string;
  note: string;
  status: string;
  token_limit: number;
  used_tokens: number;
  expires_at: string;
};
type Conversation = { id: string; title: string; grant_id: string };
type Message = { id: string; role: string; content: string; tokens?: number };
type View = "chat" | "explore" | "lending" | "access";
const num = (n: number) =>
  new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
const date = (s: string) =>
  new Date(s).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
const usable = (g: Grant) =>
  g.status === "active" &&
  new Date(g.expires_at).getTime() > Date.now() &&
  g.used_tokens < g.token_limit;
const state = (g: Grant) =>
  ["approved", "active"].includes(g.status) &&
  new Date(g.expires_at).getTime() <= Date.now()
    ? "expired"
    : g.used_tokens >= g.token_limit
      ? "exhausted"
      : g.status;
async function api<T = any>(
  path: string,
  body?: unknown,
  method?: string,
  signal?: AbortSignal,
): Promise<T> {
  const r = await fetch("/api" + path, {
    method: method || (body ? "POST" : "GET"),
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Request failed.");
  return data;
}
function Mark({ small = false }: { small?: boolean }) {
  return (
    <div className={"mark " + (small ? "small" : "")}>
      <Layers size={small ? 17 : 25} />
    </div>
  );
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
      if (e.key === "Tab") {
        const elements = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            "button,input,textarea,select,a[href]",
          ) || [],
        ).filter((el) => !el.hasAttribute("disabled"));
        const first = elements[0],
          last = elements.at(-1);
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === ref.current)
        ) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy-button"
      aria-label="Copy text"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}{" "}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
function CodeBlock({ children, ...props }: any) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>Code</span>
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(ref.current?.innerText || "");
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          <Copy size={13} /> {copied ? "Copied" : "Copy code"}
        </button>
      </div>
      <pre ref={ref} {...props}>
        {children}
      </pre>
    </div>
  );
}
export default function Home() {
  const [user, setUser] = useState<User | null>(null),
    [booting, setBooting] = useState(true),
    [view, setView] = useState<View>("chat"),
    [connected, setConnected] = useState(false),
    [provider, setProvider] = useState("codex");
  const [offers, setOffers] = useState<Offer[]>([]),
    [grants, setGrants] = useState<Grant[]>([]),
    [lending, setLending] = useState<{ offers: Offer[]; requests: Grant[] }>({
      offers: [],
      requests: [],
    });
  const [conversations, setConversations] = useState<Conversation[]>([]),
    [current, setCurrent] = useState<Conversation | null>(null),
    [messages, setMessages] = useState<Message[]>([]);
  const [selectedGrant, setSelectedGrant] = useState(""),
    [prompt, setPrompt] = useState(""),
    [sending, setSending] = useState(false),
    [busy, setBusy] = useState(false),
    [loadingMessages, setLoadingMessages] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [auth, setAuth] = useState<"login" | "register" | null>(null);
  const [offerModal, setOfferModal] = useState(false),
    [requestOffer, setRequestOffer] = useState<Offer | null>(null),
    [approval, setApproval] = useState<Grant | null>(null),
    [code, setCode] = useState(""),
    [codeModal, setCodeModal] = useState(false);
  const [connection, setConnection] = useState<{
      state: string;
      url?: string;
      code?: string;
    } | null>(null),
    [mobile, setMobile] = useState(false),
    [search, setSearch] = useState(""),
    [category, setCategory] = useState("All");
  const abort = useRef<AbortController | null>(null),
    bottom = useRef<HTMLDivElement>(null),
    textarea = useRef<HTMLTextAreaElement>(null),
    loadVersion = useRef(0);
  const refresh = useCallback(async () => {
    const [me, o, g, l, c] = await Promise.all([
      api("/me"),
      api("/offers"),
      api("/grants"),
      api("/lending"),
      api("/conversations"),
    ]);
    setUser(me.user);
    setConnected(me.connected);
    setProvider(me.provider);
    setOffers(o);
    setGrants(g);
    setLending(l);
    setConversations(c);
  }, []);
  useEffect(() => {
    api("/me")
      .then(() => refresh())
      .catch(() => {})
      .finally(() => setBooting(false));
  }, [refresh]);
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(() => refresh().catch(() => {}), 15000);
    return () => clearInterval(interval);
  }, [user?.id, refresh]);
  useEffect(() => {
    if (!connection || !["starting", "pending"].includes(connection.state))
      return;
    const timer = setInterval(
      () =>
        api("/connection")
          .then((value) => {
            setConnection(value);
            if (value.state === "connected") refresh();
          })
          .catch((e) => setError(e.message)),
      2000,
    );
    return () => clearInterval(timer);
  }, [connection?.state, refresh]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const activeGrants = grants.filter(usable),
    grant =
      grants.find((g) => g.id === (current?.grant_id || selectedGrant)) ||
      (!current ? activeGrants[0] : undefined),
    pending = lending.requests.filter((g) => g.status === "pending").length;
  function navigate(next: View) {
    setView(next);
    setMobile(false);
    setError("");
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function needUser(fn: () => void) {
    if (!user) setAuth("register");
    else fn();
  }
  async function openChat(c: Conversation) {
    if (sending) return;
    const version = ++loadVersion.current;
    setCurrent(c);
    navigate("chat");
    setLoadingMessages(true);
    setMessages([]);
    try {
      const result = await api("/conversations/" + c.id + "/messages");
      if (version === loadVersion.current) setMessages(result);
    } catch (e: any) {
      setError(e.message);
    } finally {
      if (version === loadVersion.current) setLoadingMessages(false);
    }
  }
  function newChat() {
    if (sending) return;
    loadVersion.current++;
    setLoadingMessages(false);
    setCurrent(null);
    setMessages([]);
    setPrompt("");
    navigate("chat");
    textarea.current?.focus();
  }
  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (!prompt.trim() || sending) return;
    if (!user) {
      setAuth("register");
      return;
    }
    if (!grant || !usable(grant)) {
      setError("Activate an access pass before starting a conversation.");
      return;
    }
    const content = prompt.trim();
    setError("");
    setSending(true);
    abort.current = new AbortController();
    let c = current;
    try {
      if (!c) {
        c = await api<Conversation>("/conversations", { grantId: grant.id });
        setCurrent(c);
        setConversations((list) => [c!, ...list]);
      }
      setMessages((m) => [...m, { id: "pending", role: "user", content }]);
      setPrompt("");
      const reply = await api<Message>(
        "/conversations/" + c.id + "/messages",
        { content },
        undefined,
        abort.current.signal,
      );
      setMessages((m) => [...m, reply]);
      await refresh();
    } catch (e: any) {
      setError(
        e.name === "AbortError"
          ? "Response stopped. Check your pass status before continuing."
          : e.message,
      );
      if (c) {
        try {
          setMessages(await api("/conversations/" + c.id + "/messages"));
        } catch {}
      }
      await refresh().catch(() => {});
    } finally {
      setSending(false);
      abort.current = null;
    }
  }
  async function authenticate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    await action(async () => {
      await api("/auth/" + auth, {
        email: d.get("email"),
        password: d.get("password"),
        ...(auth === "register" ? { name: d.get("name") } : {}),
      });
      await refresh();
      setAuth(null);
    });
  }
  const filtered = offers.filter(
    (o) =>
      (o.title + " " + o.description + " " + o.lender_name)
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (category !== "Coding" ||
        /code|coding|build|develop/i.test(o.title + " " + o.description)),
  );
  const formError = error && (
    <p className="form-error" role="alert">
      {error}
    </p>
  );
  return (
    <div className="app-shell">
      {mobile && (
        <button
          className="sidebar-shade"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <aside className={"sidebar " + (mobile ? "open" : "")}>
        <button className="brand" onClick={newChat}>
          <Mark small />
          <span>
            tokenhub<span className="brand-dot">.</span>
          </span>
        </button>
        <button className="new-chat" onClick={newChat} disabled={sending}>
          <Plus size={17} /> New conversation <span>↗</span>
        </button>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          <button
            className={view === "chat" ? "selected" : ""}
            onClick={() => navigate("chat")}
          >
            <MessageSquare size={17} /> Chat <span className="nav-active-dot" />
          </button>
          <button
            className={view === "explore" ? "selected" : ""}
            onClick={() => navigate("explore")}
          >
            <Globe2 size={17} /> Explore access{" "}
            <span className="mini-tag">NEW</span>
          </button>
          <button
            disabled={booting}
            className={view === "access" ? "selected" : ""}
            onClick={() => needUser(() => navigate("access"))}
          >
            <Ticket size={17} /> My access{" "}
            {activeGrants.length > 0 && (
              <span className="count">{activeGrants.length}</span>
            )}
          </button>
          <button
            disabled={booting}
            className={view === "lending" ? "selected" : ""}
            onClick={() => needUser(() => navigate("lending"))}
          >
            <HandHeart size={17} /> My lending{" "}
            {pending > 0 && <span className="count">{pending}</span>}
          </button>
        </nav>
        <div className="history-header">
          <span className="nav-label">RECENT CONVERSATIONS</span>
          <MessageSquare size={13} />
        </div>
        <div className="history">
          {conversations.length ? (
            conversations.map((c) => (
              <button
                disabled={sending}
                className={current?.id === c.id ? "current" : ""}
                key={c.id}
                onClick={() => openChat(c)}
              >
                <MessageSquare size={14} />
                <span>{c.title}</span>
              </button>
            ))
          ) : (
            <p>
              Your next great idea
              <br />
              starts with a conversation.
            </p>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="share-card">
            <div className="share-title">
              <span className="tiny-icon">
                <Zap size={15} />
              </span>{" "}
              Good AI goes further.
            </div>
            <p>
              Have a little access to spare?
              <br />
              Help someone build something.
            </p>
            <button
              disabled={booting}
              onClick={() => needUser(() => navigate("lending"))}
            >
              Become a lender <ArrowUpRight size={15} />
            </button>
          </div>
          {user ? (
            <div className="profile">
              <span className="avatar">{user.name[0].toUpperCase()}</span>
              <div>
                <strong>{user.name}</strong>
                <small>Personal workspace</small>
              </div>
              <button
                className="icon-button"
                aria-label="Sign out"
                onClick={() =>
                  action(async () => {
                    await api("/auth/logout", {});
                    window.location.reload();
                  })
                }
              >
                <LogOut size={16} />
              </button>
            </div>
          ) : (
            <button className="signin-profile" onClick={() => setAuth("login")}>
              <span className="avatar">
                <Users size={17} />
              </span>
              <span>Sign in to your workspace</span>
              <ArrowRight size={15} />
            </button>
          )}
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMobile(true)}
            >
              <Menu size={20} />
            </button>
            <span>Workspace</span>
            <span className="slash">/</span>
            <strong>
              {
                {
                  chat: "Chat",
                  explore: "Explore access",
                  lending: "My lending",
                  access: "My access",
                }[view]
              }
            </strong>
          </div>
          <div className="topbar-right">
            <span className="private-label">
              <ShieldCheck size={14} /> Private by design
            </span>
            <span className="header-divider" />
            <button
              disabled={booting}
              className="top-connect"
              onClick={() => needUser(() => navigate("access"))}
            >
              <span
                className={"status-dot " + (activeGrants.length ? "live" : "")}
              />
              {activeGrants.length ? "Access connected" : "No access connected"}
              <ChevronDown size={13} />
            </button>
          </div>
        </header>
        {provider === "demo" && user && (
          <div className="demo-banner">
            Demo mode · Sample responses only. No Codex usage is charged.
          </div>
        )}
        {error &&
          !auth &&
          !offerModal &&
          !requestOffer &&
          !approval &&
          !codeModal && (
            <div className="alert error" role="alert">
              <span>{error}</span>
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
        {notice && (
          <div className="toast" role="status">
            <CheckCircle2 size={17} />
            {notice}
          </div>
        )}
        {view === "chat" ? (
          <div
            className={"chat-view " + (messages.length ? "has-messages" : "")}
          >
            {!messages.length && !loadingMessages ? (
              <div className="welcome">
                <div className="welcome-badge">
                  <span className="live-dot" /> A little access. A lot of
                  possibility.
                </div>
                <div className="hero-symbol">
                  <Mark />
                  <span className="orbit orbit-one" />
                  <span className="orbit orbit-two" />
                  <span className="spark spark-one">✦</span>
                  <span className="spark spark-two">✧</span>
                </div>
                <h1>
                  Big ideas start
                  <br />
                  with <span>a conversation.</span>
                </h1>
                <p className="hero-description">
                  Your space to think, create, and code.
                  <br />
                  Powered by AI. Made possible by people.
                </p>
                <div className="suggestions">
                  {[
                    {
                      icon: Code2,
                      label: "Build something",
                      text: "Write a TypeScript function that debounces user input.",
                      color: "mint",
                    },
                    {
                      icon: Sparkles,
                      label: "Find the words",
                      text: "Help me write an introduction for my portfolio.",
                      color: "purple",
                    },
                    {
                      icon: Zap,
                      label: "Work through it",
                      text: "Explain database transactions with a simple example.",
                      color: "amber",
                    },
                    {
                      icon: Globe2,
                      label: "Explore an idea",
                      text: "Help me brainstorm a useful weekend project.",
                      color: "blue",
                    },
                  ].map((i) => (
                    <button
                      key={i.label}
                      onClick={() => {
                        setPrompt(i.text);
                        textarea.current?.focus();
                      }}
                    >
                      <span className={"suggestion-icon " + i.color}>
                        <i.icon size={18} />
                      </span>
                      <span>{i.label}</span>
                      <ArrowUpRight size={14} />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="message-list">
                {loadingMessages ? (
                  <div className="loading">
                    <Loader2 className="spin" /> Loading conversation
                  </div>
                ) : (
                  messages.map((m) => (
                    <article className={"message " + m.role} key={m.id}>
                      <div className="message-avatar">
                        {m.role === "assistant" ? (
                          <Mark small />
                        ) : (
                          <span className="avatar">{user?.name[0]}</span>
                        )}
                      </div>
                      <div className="message-body">
                        <div className="message-author">
                          {m.role === "assistant" ? "TokenHub" : "You"}
                          {m.role === "assistant" && <span>Codex</span>}
                        </div>
                        <div className="prose">
                          <Markdown
                            remarkPlugins={[remarkGfm]}
                            components={{ pre: CodeBlock }}
                          >
                            {m.content}
                          </Markdown>
                        </div>
                        {m.role === "assistant" && (
                          <div className="message-footer">
                            <CopyButton text={m.content} />
                            <span>{num(m.tokens || 0)} tokens this turn</span>
                          </div>
                        )}
                      </div>
                    </article>
                  ))
                )}
                {sending && (
                  <div className="thinking">
                    <Mark small />
                    <span className="thinking-dots">
                      <i />
                      <i />
                      <i />
                    </span>
                    <span>Thinking it through</span>
                  </div>
                )}
                <div ref={bottom} />
              </div>
            )}
            <div className="composer-wrap">
              {!grant && !messages.length && (
                <div className="access-nudge">
                  <div>
                    <span className="tiny-icon">
                      <KeyRound size={15} />
                    </span>
                    <span>A great conversation is one connection away.</span>
                  </div>
                  <button onClick={() => navigate("explore")}>
                    Find access <ArrowRight size={14} />
                  </button>
                </div>
              )}
              <form className="composer" onSubmit={send}>
                <textarea
                  ref={textarea}
                  aria-label="Message"
                  placeholder="Ask anything, or make something..."
                  value={prompt}
                  maxLength={12000}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
                <div className="composer-bottom">
                  <div className="composer-tools">
                    <span className="model-select">
                      <span className="model-icon">✳</span> Codex
                    </span>
                    <span className="composer-divider" />
                    <span className="text-mode">
                      <MessageSquare size={13} /> Chat mode
                    </span>
                  </div>
                  {sending ? (
                    <button
                      type="button"
                      className="send-button"
                      aria-label="Stop response"
                      onClick={() => abort.current?.abort()}
                    >
                      <Square size={15} />
                    </button>
                  ) : (
                    <button
                      className="send-button"
                      aria-label="Send message"
                      disabled={!prompt.trim() || booting || loadingMessages}
                    >
                      <ArrowUp size={19} />
                    </button>
                  )}
                </div>
              </form>
              <div className="composer-caption">
                <span>
                  <ShieldCheck size={12} /> Your conversations stay yours.
                </span>
                <span>
                  Enter to send <span className="keyboard-separator">·</span>{" "}
                  Shift + Enter for a new line
                </span>
              </div>
              {grant && (
                <div className="pass-inline">
                  <span className="live-dot" />
                  <select
                    aria-label="Active access pass"
                    disabled={!!current || sending}
                    value={grant.id}
                    onChange={(e) => setSelectedGrant(e.target.value)}
                  >
                    {(current ? [grant] : activeGrants).map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.title} · {g.lender_name}
                      </option>
                    ))}
                  </select>
                  <span>
                    {num(Math.max(0, grant.token_limit - grant.used_tokens))}{" "}
                    tokens left
                  </span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="workspace-page">
            {view === "explore" && (
              <>
                <div className="page-heading">
                  <div>
                    <span className="eyebrow">BETTER, TOGETHER</span>
                    <h1>A little access opens a lot.</h1>
                    <p>
                      Find a lender, share what you’re working on, and start a
                      conversation.
                    </p>
                  </div>
                  <span className="page-illustration">
                    <Globe2 size={52} strokeWidth={1} />
                  </span>
                </div>
                <div className="explore-toolbar">
                  <div className="tabs">
                    {["All", "Coding"].map((c) => (
                      <button
                        key={c}
                        className={category === c ? "active" : ""}
                        onClick={() => setCategory(c)}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                  <label className="search">
                    <Search size={16} />
                    <input
                      aria-label="Search access"
                      placeholder="Search access..."
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </label>
                </div>
                {!user ? (
                  <div className="empty-state">
                    <Users size={34} />
                    <h2>Good ideas deserve good company.</h2>
                    <p>
                      Create an account to explore available access
                      <br />
                      and connect with a lender.
                    </p>
                    <button
                      className="primary"
                      onClick={() => setAuth("register")}
                    >
                      Join TokenHub <ArrowRight size={16} />
                    </button>
                  </div>
                ) : filtered.length ? (
                  <div className="offer-grid">
                    {filtered.map((o) => (
                      <div className="offer-card" key={o.id}>
                        <div className="offer-top">
                          <span className="provider-badge">✳ Codex</span>
                          <span className="available">
                            <span className="live-dot" /> Available
                          </span>
                        </div>
                        <h2>{o.title}</h2>
                        <p>{o.description}</p>
                        <div className="offer-metrics">
                          <span>
                            <Zap size={15} />
                            {num(o.token_limit)} tokens / pass
                          </span>
                          <span>
                            <Clock size={15} />
                            {o.duration_minutes} min
                          </span>
                        </div>
                        <div className="offer-owner">
                          <span className="avatar">{o.lender_name[0]}</span>
                          <div>
                            <strong>{o.lender_name}</strong>
                            <small>Until {date(o.expires_at)}</small>
                          </div>
                        </div>
                        <button
                          className="secondary full-width"
                          disabled={
                            o.lender_id === user.id || !!o.request_status
                          }
                          onClick={() => setRequestOffer(o)}
                        >
                          {o.lender_id === user.id
                            ? "Your offer"
                            : o.request_status
                              ? "Request " + o.request_status
                              : "Request access"}
                          <ArrowUpRight size={15} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">
                    <Globe2 size={34} />
                    <h2>
                      {search ? "No matching access" : "Be the first to share."}
                    </h2>
                    <p>
                      {search
                        ? "Try a different search."
                        : "When someone shares their access, you’ll find it here."}
                    </p>
                    <button
                      className="primary"
                      onClick={() => navigate("lending")}
                    >
                      Share your access <Plus size={16} />
                    </button>
                  </div>
                )}
                <div className="how-it-works">
                  <span className="eyebrow">A SIMPLE WAY TO SHARE</span>
                  <div>
                    <span>
                      <b>01</b> Find your connection
                    </span>
                    <ArrowRight size={16} />
                    <span>
                      <b>02</b> Get the lender’s approval
                    </span>
                    <ArrowRight size={16} />
                    <span>
                      <b>03</b> Make something happen
                    </span>
                  </div>
                </div>
              </>
            )}
            {view === "lending" && (
              <>
                <div className="page-heading">
                  <div>
                    <span className="eyebrow">MAKE ROOM FOR SOMEONE ELSE</span>
                    <h1>Your access. Your say.</h1>
                    <p>
                      Choose who can use your AI, for how long, and how much.
                    </p>
                  </div>
                  <button
                    className="primary"
                    onClick={() =>
                      connected
                        ? setOfferModal(true)
                        : setError("Connect your Codex account below first.")
                    }
                  >
                    <Plus size={16} /> Create offer
                  </button>
                </div>
                <div className="connection-card">
                  <span className="connection-logo">✳</span>
                  <div>
                    <h3>
                      Codex connection{" "}
                      <span className={"badge " + (connected ? "active" : "")}>
                        {connected ? "Connected" : "Not connected"}
                      </span>
                    </h3>
                    <p>
                      {connected
                        ? "Your account is ready to power someone’s next idea."
                        : "Connect with a device code. Your credentials stay private."}
                    </p>
                  </div>
                  {connected ? (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        action(async () => {
                          await api("/connection", undefined, "DELETE");
                          setNotice("Disconnected. All passes revoked.");
                        })
                      }
                    >
                      Disconnect & revoke
                    </button>
                  ) : (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        action(async () => {
                          setConnection(await api("/connection", {}));
                        })
                      }
                    >
                      Connect Codex <ArrowUpRight size={15} />
                    </button>
                  )}
                </div>
                <div className="stats-grid">
                  <div>
                    <span>Open offers</span>
                    <strong>
                      {
                        lending.offers.filter(
                          (o) =>
                            o.active && new Date(o.expires_at) > new Date(),
                        ).length
                      }
                    </strong>
                  </div>
                  <div>
                    <span>Awaiting approval</span>
                    <strong>
                      {pending}
                      <span className="stat-dot" />
                    </strong>
                  </div>
                  <div>
                    <span>Tokens shared</span>
                    <strong>
                      {num(
                        lending.requests.reduce((n, g) => n + g.used_tokens, 0),
                      )}
                    </strong>
                  </div>
                </div>
                <div className="section-heading">
                  <h2>Access requests</h2>
                  <span>You’re always in control.</span>
                </div>
                {lending.requests.length ? (
                  <div className="request-list">
                    {lending.requests.map((g) => (
                      <div className="request-row" key={g.id}>
                        <span className="avatar">{g.borrower_name[0]}</span>
                        <div className="request-info">
                          <h3>
                            {g.borrower_name}{" "}
                            <span className={"badge " + state(g)}>
                              {state(g)}
                            </span>
                          </h3>
                          <small>{g.title}</small>
                          <p>{g.note}</p>
                          <small>
                            {num(g.used_tokens)} / {num(g.token_limit)} tokens
                            {g.expires_at && " · " + date(g.expires_at)}
                          </small>
                        </div>
                        <div className="request-actions">
                          {g.status === "pending" ? (
                            <>
                              <button
                                className="secondary"
                                disabled={busy}
                                onClick={() =>
                                  action(async () => {
                                    await api("/grants/" + g.id + "/deny", {});
                                  })
                                }
                              >
                                Decline
                              </button>
                              <button
                                className="primary"
                                disabled={busy}
                                onClick={() => setApproval(g)}
                              >
                                Approve <Check size={15} />
                              </button>
                            </>
                          ) : (
                            ["active", "approved"].includes(g.status) && (
                              <button
                                className="danger-button"
                                disabled={busy}
                                onClick={() =>
                                  action(async () => {
                                    await api(
                                      "/grants/" + g.id + "/revoke",
                                      {},
                                    );
                                    setNotice("Access revoked.");
                                  })
                                }
                              >
                                Revoke access
                              </button>
                            )
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-panel">
                    <Users size={24} />
                    <p>
                      Requests appear here when someone asks to use your access.
                    </p>
                  </div>
                )}
                <div className="section-heading">
                  <h2>Your offers</h2>
                </div>
                <div className="offer-grid">
                  {lending.offers.map((o) => (
                    <div className="offer-card" key={o.id}>
                      <div className="offer-top">
                        <span className="provider-badge">✳ Codex</span>
                        <span className="badge">
                          {!o.active
                            ? "Closed"
                            : new Date(o.expires_at) <= new Date()
                              ? "Expired"
                              : "Open"}
                        </span>
                      </div>
                      <h2>{o.title}</h2>
                      <p>{o.description}</p>
                      <div className="offer-metrics">
                        <span>
                          <Zap size={15} />
                          {num(o.token_limit)} / pass
                        </span>
                        <span>
                          <Clock size={15} />
                          {o.duration_minutes} min
                        </span>
                      </div>
                      {o.active && (
                        <button
                          className="secondary full-width"
                          disabled={busy}
                          onClick={() =>
                            action(async () => {
                              await api("/offers/" + o.id + "/close", {});
                              setNotice(
                                "Offer closed. Existing passes remain active.",
                              );
                            })
                          }
                        >
                          Close offer
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <p className="fine-print">
                  Allowances apply to each approved pass. Codex reports tokens
                  after a response, so the final response can exceed the
                  remaining allowance.
                </p>
              </>
            )}
            {view === "access" && (
              <>
                <div className="page-heading">
                  <div>
                    <span className="eyebrow">
                      YOUR NEXT CONVERSATION AWAITS
                    </span>
                    <h1>A pass to more possibility.</h1>
                    <p>Your requests, approved access, and remaining usage.</p>
                  </div>
                  <button
                    className="secondary"
                    onClick={() => {
                      setCode("");
                      setCodeModal(true);
                    }}
                  >
                    <KeyRound size={16} /> Redeem a code
                  </button>
                </div>
                {grants.length ? (
                  <div className="offer-grid">
                    {grants.map((g) => (
                      <div className="offer-card pass-card" key={g.id}>
                        <div className="offer-top">
                          <Ticket size={24} />
                          <span className={"badge " + state(g)}>
                            {state(g)}
                          </span>
                        </div>
                        <h2>{g.title}</h2>
                        <p>Shared by {g.lender_name}</p>
                        <div className="usage-label">
                          <span>Token allowance</span>
                          <strong>
                            {num(g.used_tokens)}{" "}
                            <span>/ {num(g.token_limit)}</span>
                          </strong>
                        </div>
                        <div className="progress-track">
                          <span
                            style={{
                              width:
                                Math.min(
                                  100,
                                  (g.used_tokens / g.token_limit) * 100,
                                ) + "%",
                            }}
                          />
                        </div>
                        <div className="pass-expiry">
                          <Clock size={14} />
                          {g.expires_at
                            ? "Ends " + date(g.expires_at)
                            : "Waiting for lender approval"}
                        </div>
                        {state(g) === "approved" ? (
                          <button
                            className="primary full-width"
                            onClick={() =>
                              action(async () => {
                                const d = await api(
                                  "/grants/" + g.id + "/code",
                                );
                                setCode(d.code);
                                setCodeModal(true);
                              })
                            }
                          >
                            View access code <KeyRound size={15} />
                          </button>
                        ) : usable(g) ? (
                          <button
                            className="secondary full-width"
                            onClick={() => {
                              setSelectedGrant(g.id);
                              newChat();
                            }}
                          >
                            Start a conversation <ArrowRight size={15} />
                          </button>
                        ) : (
                          <span className="pass-help">
                            {g.status === "pending"
                              ? "The lender will review your request."
                              : "Explore access to request a new pass."}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">
                    <Ticket size={34} />
                    <h2>Your first connection starts here.</h2>
                    <p>
                      Request access from a lender.
                      <br />
                      Once they approve, activate your personal access code.
                    </p>
                    <button
                      className="primary"
                      onClick={() => navigate("explore")}
                    >
                      Explore access <ArrowRight size={16} />
                    </button>
                  </div>
                )}
                <div className="privacy-note">
                  <ShieldCheck size={22} />
                  <div>
                    <strong>Shared access. Personal conversations.</strong>
                    <p>
                      Lenders see your usage and access request. Your chat
                      history stays in your account.
                    </p>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
        {view !== "chat" && (
          <footer className="page-footer">
            <span>tokenhub.</span>
            <span>A little generosity. A lot of possibility.</span>
            <ShieldCheck size={15} />
          </footer>
        )}
      </main>

      {auth && (
        <Modal
          title={
            auth === "register"
              ? "Make room for your next idea."
              : "Welcome back."
          }
          onClose={() => setAuth(null)}
        >
          <p className="modal-description">
            {auth === "register"
              ? "One account to borrow, lend, and create."
              : "Your conversations are right where you left them."}
          </p>
          <form className="form-stack" onSubmit={authenticate}>
            {auth === "register" && (
              <label>
                Your name
                <input
                  name="name"
                  autoComplete="name"
                  required
                  maxLength={60}
                  placeholder="Alex Morgan"
                />
              </label>
            )}
            <label>
              Email address
              <input
                type="email"
                name="email"
                autoComplete="email"
                required
                placeholder="you@example.com"
              />
            </label>
            <label>
              Password
              <input
                type="password"
                name="password"
                autoComplete={
                  auth === "register" ? "new-password" : "current-password"
                }
                required
                minLength={auth === "register" ? 10 : 1}
                maxLength={128}
                placeholder={
                  auth === "register"
                    ? "At least 10 characters"
                    : "Your password"
                }
              />
            </label>
            {formError}
            <button className="primary full-width" disabled={busy}>
              {busy ? (
                <Loader2 className="spin" size={17} />
              ) : auth === "register" ? (
                "Create account"
              ) : (
                "Sign in"
              )}
              <ArrowRight size={16} />
            </button>
          </form>
          <p className="switch-auth">
            {auth === "register"
              ? "Already have an account?"
              : "New to TokenHub?"}{" "}
            <button
              onClick={() => {
                setAuth(auth === "register" ? "login" : "register");
                setError("");
              }}
            >
              {auth === "register" ? "Sign in" : "Create account"}
            </button>
          </p>
        </Modal>
      )}
      {offerModal && (
        <Modal
          title="Share a little possibility."
          onClose={() => setOfferModal(false)}
        >
          <p className="modal-description">
            Set your terms. You’ll approve each borrower personally.
          </p>
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              const d = new FormData(e.currentTarget);
              action(async () => {
                await api("/offers", {
                  title: d.get("title"),
                  description: d.get("description"),
                  tokenLimit: Number(d.get("tokens")),
                  durationMinutes: Number(d.get("minutes")),
                  expiresAt: new Date(String(d.get("expires"))).toISOString(),
                });
                setOfferModal(false);
                setNotice("Your offer is now available.");
              });
            }}
          >
            <label>
              Offer title
              <input
                name="title"
                placeholder="A little help with your next project"
                required
                maxLength={80}
              />
            </label>
            <label>
              What can you help with?
              <textarea
                name="description"
                placeholder="Tell people who this access is for..."
                required
                maxLength={500}
              />
            </label>
            <div className="form-grid">
              <label>
                Tokens per pass
                <input
                  name="tokens"
                  type="number"
                  min={1000}
                  max={10000000}
                  defaultValue={50000}
                  required
                />
              </label>
              <label>
                Access duration (minutes)
                <input
                  name="minutes"
                  type="number"
                  min={1}
                  max={43200}
                  defaultValue={60}
                  required
                />
              </label>
            </div>
            <label>
              Available until
              <input name="expires" type="datetime-local" required />
            </label>
            <p className="fine-print">
              Access starts at approval. Each pass gets its own allowance. The
              last response may exceed it because Codex reports usage after
              completion.
            </p>
            {formError}
            <button className="primary full-width" disabled={busy}>
              Publish offer <ArrowUpRight size={16} />
            </button>
          </form>
        </Modal>
      )}
      {requestOffer && (
        <Modal
          title="Start with a hello."
          onClose={() => setRequestOffer(null)}
        >
          <p className="modal-description">
            Ask {requestOffer.lender_name} for access to “{requestOffer.title}”.
          </p>
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              const note = new FormData(e.currentTarget).get("note");
              action(async () => {
                await api("/offers/" + requestOffer.id + "/request", { note });
                setRequestOffer(null);
                setNotice("Request sent. Find updates in My access.");
              });
            }}
          >
            <label>
              What are you working on?
              <textarea
                name="note"
                required
                maxLength={500}
                placeholder="I’m learning TypeScript and could use a little help..."
              />
            </label>
            <div className="request-summary">
              <span>
                <Zap size={15} />
                {num(requestOffer.token_limit)} tokens
              </span>
              <span>
                <Clock size={15} />
                {requestOffer.duration_minutes} minutes
              </span>
            </div>
            {formError}
            <button className="primary full-width" disabled={busy}>
              Send request <ArrowRight size={16} />
            </button>
          </form>
        </Modal>
      )}
      {approval && (
        <Modal
          title={"Approve " + approval.borrower_name}
          onClose={() => setApproval(null)}
        >
          <p className="modal-description">
            Choose their allowance. You can revoke access anytime.
          </p>
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              const d = new FormData(e.currentTarget);
              action(async () => {
                await api("/grants/" + approval.id + "/approve", {
                  tokenLimit: Number(d.get("tokens")),
                  durationMinutes: Number(d.get("minutes")),
                });
                setApproval(null);
                setNotice("Approved. Their code is ready in My access.");
              });
            }}
          >
            <label>
              Token allowance
              <input
                name="tokens"
                type="number"
                min={1}
                max={approval.token_limit}
                defaultValue={approval.token_limit}
                required
              />
            </label>
            <label>
              Duration (minutes)
              <input
                name="minutes"
                type="number"
                min={1}
                max={
                  lending.offers.find((o) => o.id === approval.offer_id)
                    ?.duration_minutes
                }
                defaultValue={
                  lending.offers.find((o) => o.id === approval.offer_id)
                    ?.duration_minutes || 60
                }
                required
              />
            </label>
            {formError}
            <button className="primary full-width" disabled={busy}>
              Approve & issue code <Check size={16} />
            </button>
          </form>
        </Modal>
      )}
      {codeModal && (
        <Modal
          title="Your key to the conversation."
          onClose={() => setCodeModal(false)}
        >
          <p className="modal-description">
            This code belongs to your account and can be redeemed once.
          </p>
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              action(async () => {
                const result = await api("/redeem", { code });
                setSelectedGrant(result.id);
                setCodeModal(false);
                setNotice("Access activated. You’re ready to chat.");
              });
            }}
          >
            <label>
              Access code
              <textarea
                className="code-input"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="TH-..."
                required
                maxLength={100}
              />
            </label>
            {code && <CopyButton text={code} />}
            <button
              className="primary full-width"
              disabled={busy || !code.trim()}
            >
              Activate access <KeyRound size={16} />
            </button>
            {formError}
          </form>
        </Modal>
      )}
      {connection && (
        <Modal
          title="Connect your Codex account"
          onClose={() => setConnection(null)}
        >
          {connection.state === "connected" ? (
            <div className="connection-success">
              <CheckCircle2 size={40} />
              <h3>You’re connected.</h3>
              <p>Create an offer to start sharing.</p>
              <button className="primary" onClick={() => setConnection(null)}>
                Done
              </button>
            </div>
          ) : connection.state === "failed" ? (
            <p className="form-error">
              Sign-in did not complete. Enable device-code login in your ChatGPT
              security settings, then try again.
            </p>
          ) : (
            <div className="form-stack">
              <p className="modal-description">
                Sign in directly with OpenAI to authorize Codex. TokenHub never
                asks for your ChatGPT password.
              </p>
              {connection.code ? (
                <>
                  <div className="device-code">
                    {connection.code}
                    <CopyButton text={connection.code} />
                  </div>
                  <a
                    className="primary full-width"
                    href={connection.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open OpenAI sign-in <ArrowUpRight size={16} />
                  </a>
                </>
              ) : (
                <p className="loading">
                  <Loader2 className="spin" size={18} /> Preparing your device
                  code…
                </p>
              )}
              <p className="fine-print">
                Waiting for sign-in. This updates automatically.
              </p>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
