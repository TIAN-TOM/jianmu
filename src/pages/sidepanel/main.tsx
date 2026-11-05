import { signal } from "@preact/signals";
import { render } from "preact";

const status = signal("简幕正在重写，尚未发布。");

function App() {
  return <p>{status}</p>;
}

const root = document.getElementById("app");
if (root) render(<App />, root);
