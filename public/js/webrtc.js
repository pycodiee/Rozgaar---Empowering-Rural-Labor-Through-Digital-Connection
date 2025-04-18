let localStream;
let remoteStream;
let peerConnection;
let socket;
let roomId = 'default-room'; // You can implement dynamic room creation

const servers = {
    iceServers: [
        {
            urls: [
                'stun:stun1.l.google.com:19302',
                'stun:stun2.l.google.com:19302'
            ]
        }
    ]
};

// Initialize when the page loads
document.addEventListener('DOMContentLoaded', () => {
    // Get video elements
    const localVideo = document.getElementById('localVideo');
    const remoteVideo = document.getElementById('remoteVideo');

    // Initialize socket connection
    socket = io('/');
});

// Initialize the connection
async function init() {
    try {
        // Get user media with specific constraints
        localStream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                facingMode: 'user'
            },
            audio: true
        });

        // Get local video element and set its source
        const localVideo = document.getElementById('localVideo');
        localVideo.srcObject = localStream;
        
        // Ensure video plays when loaded
        localVideo.onloadedmetadata = () => {
            localVideo.play().catch(err => {
                console.error('Error auto-playing local video:', err);
            });
        };

        // Join room and setup connection
        socket.emit('join-room', roomId, socket.id);
        setupSocketListeners();

    } catch (error) {
        console.error('Error accessing media devices:', error);
        alert('Error accessing camera/microphone. Please ensure permissions are granted.');
    }
}

function setupSocketListeners() {
    socket.on('user-connected', userId => {
        console.log('User connected:', userId);
        createPeerConnection();
        createOffer();
    });

    socket.on('offer', async offer => {
        if (!peerConnection) {
            createPeerConnection();
        }
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        createAnswer();
    });

    socket.on('answer', async answer => {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    });

    socket.on('ice-candidate', candidate => {
        if (peerConnection) {
            peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
                .catch(e => console.error('Error adding ICE candidate:', e));
        }
    });
}

function createPeerConnection() {
    peerConnection = new RTCPeerConnection(servers);

    remoteStream = new MediaStream();
    const remoteVideo = document.getElementById('remoteVideo');
    remoteVideo.srcObject = remoteStream;

    // Add local tracks to peer connection
    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    // Handle incoming tracks
    peerConnection.ontrack = event => {
        event.streams[0].getTracks().forEach(track => {
            remoteStream.addTrack(track);
        });
    };

    // Handle ICE candidates
    peerConnection.onicecandidate = event => {
        if (event.candidate) {
            socket.emit('ice-candidate', event.candidate, roomId);
        }
    };

    // Log connection state changes
    peerConnection.onconnectionstatechange = () => {
        console.log('Connection state:', peerConnection.connectionState);
    };
}

// Create offer
async function createOffer() {
    try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit('offer', offer, roomId);
    } catch (error) {
        console.error('Error creating offer:', error);
    }
}

// Create answer
async function createAnswer() {
    try {
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('answer', answer, roomId);
    } catch (error) {
        console.error('Error creating answer:', error);
    }
}

// Update the start call button handler
document.getElementById('startCall').addEventListener('click', () => {
    init().catch(err => {
        console.error('Error starting call:', err);
        alert('Failed to start call. Please check console for details.');
    });
});

// Handle end call button
document.getElementById('endCall').addEventListener('click', () => {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    if (peerConnection) {
        peerConnection.close();
    }
    document.getElementById('localVideo').srcObject = null;
    document.getElementById('remoteVideo').srcObject = null;
});

// Handle mute button
document.getElementById('muteAudio').addEventListener('click', function() {
    const audioTrack = localStream.getAudioTracks()[0];
    audioTrack.enabled = !audioTrack.enabled;
    this.textContent = audioTrack.enabled ? 'Mute' : 'Unmute';
});

// Handle video toggle button
document.getElementById('toggleVideo').addEventListener('click', function() {
    const videoTrack = localStream.getVideoTracks()[0];
    videoTrack.enabled = !videoTrack.enabled;
    this.textContent = videoTrack.enabled ? 'Turn Off Video' : 'Turn On Video';
});
