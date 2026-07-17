import './thinking-spinner.scss';

const ThinkingSpinner = () => (
  <span className="thinking-spinner" aria-hidden="true">
    <span className="thinking-spinner__dot thinking-spinner__dot--n" />
    <span className="thinking-spinner__dot thinking-spinner__dot--e" />
    <span className="thinking-spinner__dot thinking-spinner__dot--s" />
    <span className="thinking-spinner__dot thinking-spinner__dot--w" />
  </span>
);

export default ThinkingSpinner;
