import "./style.css";
import { createBackground } from "./background.js";
import { initScrollReveal } from "./reveal.js";

const canvas = document.getElementById("bg");
createBackground(canvas);
initScrollReveal();
