import { Show, createContext, createUniqueId, useContext, type Component, type JSX } from "solid-js";

const SettingContext = createContext<{ label: string; hint?: string }>();

export const Row: Component<{ label: string; hint?: string; children: JSX.Element }> = (props) => {
  const id = createUniqueId();
  return (
    <SettingContext.Provider value={{ label: `${id}-label`, hint: props.hint ? `${id}-hint` : undefined }}>
      <div
        class="set-row"
        role="group"
        aria-labelledby={`${id}-label`}
        aria-describedby={props.hint ? `${id}-hint` : undefined}
      >
        <div class="set-row-text">
          <span id={`${id}-label`} class="set-row-label">
            {props.label}
          </span>
          <Show when={props.hint}>
            <span id={`${id}-hint`} class="set-row-hint">
              {props.hint}
            </span>
          </Show>
        </div>
        <div class="set-row-control">{props.children}</div>
      </div>
    </SettingContext.Provider>
  );
};

export const Toggle: Component<{ on: boolean; disabled?: boolean; onClick: () => void }> = (props) => {
  const setting = useContext(SettingContext);
  return (
    <button
      type="button"
      role="switch"
      disabled={props.disabled}
      aria-checked={props.on}
      aria-labelledby={setting?.label}
      aria-describedby={setting?.hint}
      classList={{ "shields-toggle": true, on: props.on }}
      onClick={() => props.onClick()}
    >
      {props.on ? "On" : "Off"}
    </button>
  );
};
