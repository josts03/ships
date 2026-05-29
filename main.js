import './style.css';
import { Game } from './game/Game.js';

const canvasElement = document.getElementById('game');
const game = new Game(canvasElement);
game.start();

// Handy for debugging in the console.
window.__game = game;
window.game   = game;   // alias — lets you type `game.map.isLand(400, 400)` directly
