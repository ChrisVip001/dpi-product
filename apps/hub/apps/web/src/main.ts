import { createApp } from "vue";
import App from "./App.vue";
import { initLocale } from "./i18n";
import "./style.css";
import "./network.css";
import "./jobs.css";
import "./extensions.css";

await initLocale();
createApp(App).mount("#app");
