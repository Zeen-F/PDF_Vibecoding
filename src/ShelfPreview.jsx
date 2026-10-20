import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, ListFilter, Moon, Search, Sun, X } from "lucide-react";
const shelfPreview = new URLSearchParams(window.location.search).get("visual") === "shanlan";
function ShelfPreferences() {
  const [compact, setCompact] = useState(true);
  const [moon, setMoon] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.shelfDensity = compact ? "compact" : "comfortable";
    document.documentElement.dataset.shelfScene = moon ? "moon" : "dawn";
    return () => {
      delete document.documentElement.dataset.shelfDensity;
      delete document.documentElement.dataset.shelfScene;
    };
  }, [compact, moon]);
  return <div className="shelf-preferences" aria-label="预览外观">
      <button
    aria-label="紧凑列表"
    aria-pressed={compact}
    title={compact ? "\u5207\u6362\u4E3A\u8212\u5C55\u5217\u8868" : "\u5207\u6362\u4E3A\u7D27\u51D1\u5217\u8868"}
    onClick={() => setCompact((value) => !value)}
  >
        <ListFilter size={14} />
        {compact ? "\u7D27\u51D1" : "\u8212\u5C55"}
      </button>
      <button
    aria-label="月下场景"
    aria-pressed={moon}
    title={moon ? "\u5207\u6362\u4E3A\u6668\u95F4\u5C71\u5C9A" : "\u5207\u6362\u4E3A\u6708\u4E0B\u5C71\u5C9A"}
    onClick={() => setMoon((value) => !value)}
  >
        {moon ? <Moon size={14} /> : <Sun size={14} />}
        {moon ? "\u6708\u4E0B" : "\u5C71\u5C9A"}
      </button>
    </div>;
}
function ShelfJump({
  items,
  noun,
  onOpen
}) {
  const dialog = useRef(null);
  const trigger = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const id = useId();
  const matches = items.filter(
    (item) => item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  );
  const visible = matches.slice(0, 100);
  const index = Math.min(selected, Math.max(0, visible.length - 1));
  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
      dialog.current?.querySelector("input")?.focus();
    }
  }, [open]);
  useEffect(() => {
    if (open)
      document.getElementById(`${id}-${index}`)?.scrollIntoView({ block: "nearest" });
  }, [index, open, id]);
  function close() {
    dialog.current?.close();
    setOpen(false);
    trigger.current?.focus();
  }
  function choose(item) {
    close();
    void onOpen(item.id);
  }
  return <>
      <button
    className="shelf-jump-trigger"
    ref={trigger}
    aria-label={`\u5FEB\u901F\u5B9A\u4F4D${noun}`}
    title={`\u6309\u6807\u9898\u5FEB\u901F\u5B9A\u4F4D${noun}`}
    onClick={() => {
      setQuery("");
      setSelected(0);
      setOpen(true);
    }}
  >
        <Search size={16} />
      </button>
      {open && <dialog
    className="shelf-jump"
    ref={dialog}
    aria-modal="true"
    aria-labelledby={`${id}-title`}
    onCancel={(event) => {
      event.preventDefault();
      close();
    }}
    onClose={() => setOpen(false)}
    onKeyDown={(event) => {
      if (event.key !== "Tab") return;
      const stops = [...event.currentTarget.querySelectorAll('button:not([tabindex="-1"]), input')]
        .filter(element => !element.disabled);
      const current = stops.indexOf(document.activeElement);
      const next = (current + (event.shiftKey ? -1 : 1) + stops.length) % stops.length;
      if (stops[next]) {
        event.preventDefault();
        stops[next].focus();
      }
    }}
  >
          <div className="shelf-jump-heading">
            <div>
              <small>循卷而行</small>
              <h2 id={`${id}-title`}>快速定位{noun}</h2>
            </div>
            <button aria-label="关闭快速定位" onClick={close}>
              <X size={18} />
            </button>
          </div>
          <label className="shelf-jump-search">
            <Search size={17} />
            <input
    autoFocus
    aria-label={`\u6309\u6807\u9898\u67E5\u627E${noun}`}
    role="combobox"
    aria-expanded="true"
    aria-controls={`${id}-list`}
    aria-autocomplete="list"
    aria-activedescendant={visible.length ? `${id}-${index}` : void 0}
    value={query}
    placeholder={`\u8F93\u5165${noun}\u6807\u9898\u2026`}
    onChange={(event) => {
      setQuery(event.target.value);
      setSelected(0);
    }}
    onKeyDown={(event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelected(
          Math.max(
            0,
            Math.min(
              visible.length - 1,
              index + (event.key === "ArrowDown" ? 1 : -1)
            )
          )
        );
      }
      if (event.key === "Enter" && visible[index]) {
        event.preventDefault();
        choose(visible[index]);
      }
    }}
  />
          </label>
          <div
    className="shelf-jump-results"
    id={`${id}-list`}
    role="listbox"
    aria-label={`${noun}\u6807\u9898`}
  >
            {visible.map((item, i) => <button
    key={item.id}
    id={`${id}-${i}`}
    role="option"
    aria-selected={i === index}
    tabIndex={-1}
    onClick={() => choose(item)}
    onMouseEnter={() => setSelected(i)}
  >
                <span className="shelf-jump-number">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.detail}</small>
                </span>
                <ArrowUpRight size={15} />
              </button>)}
          </div>
          {!visible.length && <p className="shelf-jump-empty">
              没有匹配的{noun}，试试更短的标题。
            </p>}
          <p className="shelf-jump-help">
            <span>
              {matches.length > 100 ? `\u663E\u793A\u524D 100 / ${matches.length} \u9879\uFF0C\u8BF7\u7F29\u5C0F\u8303\u56F4` : `${matches.length} \u9879 \xB7 \u4EC5\u68C0\u7D22\u6807\u9898`}
            </span>
            <span>↑↓ 选择 · Enter 打开 · Esc 返回</span>
          </p>
        </dialog>}
    </>;
}
export {
  ShelfJump,
  ShelfPreferences,
  shelfPreview
};
