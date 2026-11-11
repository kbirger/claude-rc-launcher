import { mount } from "svelte";
import "./app.css";
import Root from "./Root.svelte";
import { applyTheme } from "./shared/theme";

applyTheme();
mount(Root, { target: document.getElementById("app")! });
