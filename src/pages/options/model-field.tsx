// 模型框：能手填。拉到模型列表以后是带候选的输入框：边打字边筛，点框或右边的箭头列出拉到的全部模型，
// 框里已经有字也一样。候选只是帮着填，列表里没有的名称照样能填、能保存。
// 焦点一直留在输入框里，上下方向键在候选里移动，回车选中，Esc 收起。
import { useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Icon } from "../shared/ui/icon.tsx";
import { listSide, matchModels, modelParts, stepModel } from "./model-options.ts";

export interface ModelFieldProps {
  readonly models: readonly string[];
  readonly value: string;
  readonly placeholder: string;
  /** 右边箭头和候选列表的无障碍名称。 */
  readonly pickLabel: string;
  readonly id: string;
  readonly feature?: string;
  readonly onValue: (value: string) => void;
}

/** 候选列表和输入框之间、和视口边缘之间留的空，单位是像素。 */
const LIST_GAP = 8;

export function ModelField({ models, value, placeholder, pickLabel, id, feature, onValue }: ModelFieldProps) {
  const listId = `${useId()}-models`;
  const root = useRef<HTMLSpanElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  // 打字打开的按框里的字筛；点框、点箭头、按方向键打开的列出全部。
  const [filtering, setFiltering] = useState(false);
  const [active, setActive] = useState(-1);
  const [side, setSide] = useState<"top" | "bottom">("bottom");

  const shown = open ? (filtering ? matchModels(models, value) : models) : [];
  const expanded = shown.length > 0;
  const current = active >= 0 && active < shown.length ? active : -1;

  useLayoutEffect(() => {
    const box = root.current;
    const menu = list.current;
    const view = box?.ownerDocument.defaultView;
    if (!expanded || !box || !menu || !view) return;
    const at = box.getBoundingClientRect();
    setSide(listSide({ above: at.top - LIST_GAP, below: view.innerHeight - at.bottom - LIST_GAP }, menu.offsetHeight + LIST_GAP));
  }, [expanded, shown.length]);

  useLayoutEffect(() => {
    if (current >= 0) list.current?.children[current]?.scrollIntoView({ block: "nearest" });
  }, [current, expanded]);

  const close = (): void => {
    setOpen(false);
    setActive(-1);
  };
  const openAll = (start: number): void => {
    setOpen(true);
    setFiltering(false);
    setActive(start);
  };
  const choose = (model: string): void => {
    onValue(model);
    close();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (models.length === 0 || event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!expanded) {
        const chosen = models.indexOf(value);
        openAll(chosen >= 0 ? chosen : stepModel(event.key, -1, models.length));
        return;
      }
      setActive(stepModel(event.key, current, shown.length));
      return;
    }
    if (!expanded) return;
    if (event.key === "Enter") {
      event.preventDefault();
      const model = shown[current];
      if (model === undefined) close();
      else choose(model);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  return (
    <span
      ref={root}
      class="model-field"
      data-pick={models.length ? "true" : undefined}
      data-open={expanded ? "true" : undefined}
      data-side={side}
      onFocusOut={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !root.current?.contains(next)) close();
      }}
    >
      <input
        ref={input}
        class="input"
        id={id}
        data-feature={feature}
        type="text"
        role={models.length ? "combobox" : undefined}
        aria-autocomplete={models.length ? "list" : undefined}
        aria-expanded={models.length ? expanded : undefined}
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={current >= 0 ? `${listId}-${current}` : undefined}
        autocomplete="off"
        spellcheck={false}
        placeholder={placeholder}
        value={value}
        onInput={(event) => {
          onValue(event.currentTarget.value);
          if (models.length === 0) return;
          setOpen(true);
          setFiltering(true);
          setActive(-1);
        }}
        onClick={() => {
          if (models.length && !expanded) openAll(models.indexOf(value));
        }}
        onKeyDown={onKeyDown}
      />
      {models.length ? (
        <button
          type="button"
          class="model-toggle"
          tabIndex={-1}
          aria-label={pickLabel}
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          data-model-pick={feature ?? id}
          // 按下时不让焦点离开输入框，列表才不会先被失焦收起。
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            input.current?.focus();
            if (expanded) close();
            else openAll(models.indexOf(value));
          }}
        >
          <Icon name="chevron" />
        </button>
      ) : null}
      {expanded ? (
        <ul ref={list} id={listId} class="model-list" role="listbox" aria-label={pickLabel}>
          {shown.map((model, index) => (
            <li
              key={model}
              id={`${listId}-${index}`}
              class="model-option"
              role="option"
              aria-selected={model === value}
              data-active={index === current ? "true" : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => {
                if (index !== current) setActive(index);
              }}
              onClick={() => choose(model)}
            >
              <span class="model-name">
                {(filtering ? modelParts(model, value) : [{ text: model, hit: false }]).map((part, at) => (part.hit ? <mark key={at}>{part.text}</mark> : part.text))}
              </span>
              {model === value ? <Icon name="check" /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </span>
  );
}
