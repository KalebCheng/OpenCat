import ReactDOM from "react-dom/client";

import App from "./App";
import "./styles/globals.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("the #root container is missing from index.html");
}

// StrictMode is deliberately omitted: it double-invokes effects in development,
// which would open every database connection twice.
ReactDOM.createRoot(container).render(<App />);
