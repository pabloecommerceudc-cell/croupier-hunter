const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Hand = require('pokersolver').Hand;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let gameState = {
    players: [], dealerCards: [], pot: 0, houseProfit: 0, deck: [],
    baseBlind: 5, currentBlind: 5, phase: 'ESPERANDO', turnIndex: 0
};

function createDeck() {
    const suits = ['h', 'd', 'c', 's'];
    const values = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
    let deck = [];
    for (let s of suits) { for (let v of values) deck.push(v + s); }
    return deck.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
    socket.on('join', (name) => {
        if (gameState.currentBlind > gameState.baseBlind || gameState.players.length >= 5) {
            socket.emit('message', 'Mesa cerrada: bote acumulado o mesa llena.');
            return;
        }
        gameState.players.push({ id: socket.id, name: name, chips: 100, cards: [], status: 'ESPERANDO' });
        io.emit('update', gameState);
    });

    socket.on('startRound', () => {
        if (gameState.players.length < 2) return;
        gameState.deck = createDeck();
        gameState.dealerCards = gameState.deck.splice(0, 5);
        gameState.turnIndex = 0;
        
        gameState.players.forEach(p => {
            if (p.chips >= gameState.currentBlind) {
                p.chips -= gameState.currentBlind;
                gameState.pot += gameState.currentBlind;
                p.cards = gameState.deck.splice(0, 5);
                p.status = 'ESPERANDO_TURNO';
            }
        });
        
        gameState.players[0].status = 'TU_TURNO';
        gameState.phase = 'ACCION';
        io.emit('update', gameState);
    });

    socket.on('action', (data) => {
        let playerIndex = gameState.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== gameState.turnIndex || gameState.phase !== 'ACCION') return;
        let p = gameState.players[playerIndex];

        if (data.type === 'FOLD') {
            p.status = 'FOLD'; p.cards = [];
            io.emit('message', `${p.name} se ha retirado.`);
        } else if (data.type === 'DESCARTE') {
            let numCards = data.cards.length;
            let cost = numCards === 1 ? 1 : numCards === 2 ? 3 : 6;
            if (p.chips >= cost && numCards <= 3) {
                p.chips -= cost; gameState.houseProfit += cost;
                data.cards.forEach(idx => { p.cards[idx] = gameState.deck.pop(); });
                p.status = 'LISTO';
                io.emit('message', `${p.name} pidió ${numCards} cartas.`);
            }
        } else if (data.type === 'PLANTARSE') {
            p.status = 'LISTO';
            io.emit('message', `${p.name} se planta.`);
        }

        do { gameState.turnIndex++; } 
        while (gameState.turnIndex < gameState.players.length && gameState.players[gameState.turnIndex].status === 'FOLD');

        if (gameState.turnIndex >= gameState.players.length) checkResolution();
        else {
            gameState.players[gameState.turnIndex].status = 'TU_TURNO';
            io.emit('update', gameState);
        }
    });

    function checkResolution() {
        let active = gameState.players.filter(p => p.status === 'LISTO');
        if (active.length === 0) {
            gameState.currentBlind++; gameState.phase = 'ESPERANDO';
            io.emit('message', 'Todos retirados. Bote acumulado.');
            io.emit('update', gameState);
            return;
        }

        gameState.phase = 'RESOLUCION';
        let dealerHand = Hand.solve(gameState.dealerCards);
        let califica = dealerHand.rank >= 1 || (dealerHand.name === 'High Card' && dealerHand.cards[0].value === 'A' && dealerHand.cards[1].value === 'K');

        if (!califica) {
            gameState.currentBlind++;
            io.emit('message', 'El crupier NO califica. Bote acumulado.');
        } else {
            let ganadores = [];
            active.forEach(p => {
                let pHand = Hand.solve(p.cards);
                if (pHand.descr === dealerHand.descr || pHand === Hand.winners([pHand, dealerHand])[0]) {
                    ganadores.push({ player: p, hand: pHand });
                }
            });

            if (ganadores.length === 0) {
                gameState.currentBlind++;
                io.emit('message', 'Crupier gana. Bote acumulado.');
            } else {
                let rake = Math.floor(gameState.pot * 0.05);
                gameState.houseProfit += rake;
                let premioFinal = gameState.pot - rake;
                let mejorMano = Hand.winners(ganadores.map(g => g.hand))[0];
                let campeones = ganadores.filter(g => g.hand === mejorMano);
                let premioPorCabeza = Math.floor(premioFinal / campeones.length);
                
                campeones.forEach(c => c.player.chips += premioPorCabeza);
                gameState.pot = 0; gameState.currentBlind = gameState.baseBlind;
                io.emit('message', `¡Ganador! Bote repartido. Ciega reiniciada.`);
            }
        }
        setTimeout(() => { gameState.phase = 'ESPERANDO'; io.emit('update', gameState); }, 8000);
    }
});
server.listen(process.env.PORT || 3000);