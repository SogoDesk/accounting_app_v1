import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import logo from "../assets/tetriq-no-bg.png";
import "./login.css";

const SunIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2" />
    <path d="M12 20v2" />
    <path d="m4.93 4.93 1.41 1.41" />
    <path d="m17.66 17.66 1.41 1.41" />
    <path d="M2 12h2" />
    <path d="M20 12h2" />
    <path d="m6.34 17.66-1.41 1.41" />
    <path d="m19.07 4.93-1.41 1.41" />
  </svg>
);

const MoonIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 3a6 6 0 1 0 9 9 9 9 0 1 1-9-9z" />
  </svg>
);

function LoginPage() {
  const { login } = useAuth();
  const { dark, toggle } = useTheme();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");

    if (!email || !password) {
      setError("Please enter both email and password.");
      return;
    }

    try {
      setLoading(true);
      await login(email.trim(), password);
      navigate("/dashboard");
    } catch (err) {
      console.error(err);
      setError(
        err.response?.data?.message ||
          err.response?.data?.error ||
          "Unable to sign in. Please check your credentials.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-theme-toggle">
        <button
          type="button"
          className={`theme-toggle ${dark ? "theme-toggle-dark" : "theme-toggle-light"}`.trim()}
          aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
          onClick={toggle}
          title={dark ? "Switch to light mode" : "Switch to dark mode"}
        >
          <span className="theme-toggle-icon" aria-hidden="true">
            {dark ? <MoonIcon /> : <SunIcon />}
          </span>
          <span>{dark ? "Dark" : "Light"}</span>
        </button>
      </div>

      <div className="login-orb orb-a"></div>
      <div className="login-orb orb-b"></div>
      <div className="login-orb orb-c"></div>

      <div className="login-shell">
        <div
          className="login-card"
          onMouseMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            event.currentTarget.style.setProperty("--spot-x", `${x}px`);
            event.currentTarget.style.setProperty("--spot-y", `${y}px`);
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.setProperty("--spot-x", "50%");
            event.currentTarget.style.setProperty("--spot-y", "40%");
          }}
        >
          <div className="login-logo">
            <img className="logo-image" src={logo} alt="TetriQ Solutions" />
          </div>

          <h1>Accounting</h1>
          <p>Revenue Management Platform</p>

          <form onSubmit={handleSubmit} className="login-form">
            <label htmlFor="login-email">Email Address</label>
            <input
              id="login-email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-label="Email address"
            />

            <label htmlFor="login-password">Password</label>
            <div className="input-wrap">
              <input
                id="login-password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-label="Password"
              />
              <button
                type="button"
                className="toggle-btn"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>

            {error && (
              <div className="login-error" role="alert" aria-live="polite">
                <span className="error-icon">!</span>
                {error}
              </div>
            )}

            <button className="login-btn" type="submit" disabled={loading}>
              <span className="btn-text">
                {loading ? "Signing In" : "Secure Login"}
              </span>
              {loading && <span className="spinner" aria-hidden="true"></span>}
            </button>
          </form>

          <div className="login-footnote">Powered by TetriQ Solutions.</div>
        </div>
      </div>
    </div>
  );
}

export default LoginPage;
