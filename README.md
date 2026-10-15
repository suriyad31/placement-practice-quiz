# Placement Practice Quiz

Timed placement practice in aptitude and core CS subjects. The Express server checks answers and scores quizzes. Users sign in with an account; passwords are stored as salted scrypt hashes, sessions use HttpOnly cookies, and submitted results are saved in SQLite.

## Requirements

- Node.js 22.5 or newer (uses the built-in `node:sqlite` module)
- npm

## Run locally

```sh
npm ci
npm start
```

Open http://localhost:3000. Register an account to begin. Set `PORT` to use another port.

The database is created automatically at `data/placement-quiz.sqlite` and is excluded from version control. Quiz history is available on the home page after sign-in. In-progress timers are held in server memory and are cleared when the server restarts.
