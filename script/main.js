const DEVEL = true;
const ROOT = "../";

document.body.addEventListener("dblclick", function(){
    // Togle full screen
    if (!document.fullscreenElement &&    // alternative standard method
        !document.mozFullScreenElement && 
        !document.webkitFullscreenElement && 
        !document.msFullscreenElement ) {  // current working methods
        if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen();
        } else if (document.documentElement.mozRequestFullScreen) {
            document.documentElement.mozRequestFullScreen();
        } else if (document.documentElement.webkitRequestFullscreen) {
            document.documentElement.webkitRequestFullscreen(Element.ALLOW_KEYBOARD_INPUT);
        } else if (document.documentElement.msRequestFullscreen) {
            document.documentElement.msRequestFullscreen();
        }

    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.mozCancelFullScreen) {
            document.mozCancelFullScreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        } else if (document.msExitFullscreen) {
            document.msExitFullscreen();
        }

    }
});

let credentials = null;

function loadCredentials(){

}

// const USERT_STATUS = Object.freeze({
//     GUEST: 1,
//     LOGED_IN: 2,
//     ADMIN: 3 // Ha ha ha.. I may be an idiot, but I aint stupid
// });

let userInformation = {
    // status: USERT_STATUS.GUEST,
    // username: null,
    // key: null,

    nickname: "Frode",
    difficulty: 2,
    ftp: 340,
    weight: 75,
    skins: {main: "default", secondaries: []},
    mostRecentGame: "./games/PartySpin",
}

// DO ONCE: Load user information
{
    let loadData = window.localStorage.getItem("userInformation");
    if(loadData){
        loadData = JSON.parse(loadData);
        // TODO: assert user-information is not corrupted
        userInformation = loadData;
    }
    else{
        window.localStorage.setItem("userInformation", JSON.stringify(userInformation));
    }

    document.getElementById("mostRecentGame").innerHTML = "<img src='"+userInformation.mostRecentGame+"/media/iconMain.png'>";

    document.getElementById("nickname").value = userInformation.nickname;
    document.getElementById("difficulty").value = userInformation.difficulty;
    document.getElementById("ftp").value = userInformation.ftp;
    document.getElementById("weight").value = userInformation.weight;
}

let menuStack = ["home"];

document.getElementById("backButton").addEventListener("click", function(){
    var i;
    for(i = 0; i < menuStack.length; i++){
        document.getElementById(menuStack[i]).style.display = "none";
    }
    if (i){
        menuStack.pop();
        document.getElementById(menuStack[menuStack.length-1]).style.display = "flex";
    }
    else{
        document.getElementById("home").style.display = "flex";
    }

    if(menuStack.length == 1){
        this.style.display = "none";
    }
});

function go2SubMenu(id){

    for(var i = 0; i < menuStack.length; i++){
        document.getElementById(menuStack[i]).style.display = "none";
    }

    menuStack.push(id);
    document.getElementById(id).style.display = "flex";
    document.getElementById("backButton").style.display = "flex";

    if(id == "home"){
        menuStack = ["home"];
        document.getElementById("backButton").style.display = "none";
    }
}

let allHomeMenuOptions = document.getElementsByClassName("homeMenuOptionsElement");
for(var i = 0; i < allHomeMenuOptions.length; i++){
    allHomeMenuOptions[i].addEventListener("click", function(){
        let newSite = this.getAttribute("site");
        if(newSite != null && newSite != "mostRecentGame") go2SubMenu(newSite);
        else if (newSite = "mostRecentGame") window.location.href = userInformation.mostRecentGame;
    });
}

document.getElementById("editSkinBT").addEventListener("click", function(){
    go2SubMenu(this.getAttribute("site"));
});


///////////////////////////////////////////////////////////////
////                        Profile                         ///
///////////////////////////////////////////////////////////////



///////////////////////////////////////////////////////////////
////                        History                         ///
///////////////////////////////////////////////////////////////







///////////////////////////////////////////////////////////////
////                      3D Graphichs                      ///
///////////////////////////////////////////////////////////////

import * as THREE from '../script/three/build/three.module.js';
import {OrbitControls} from '../script/three/examples/jsm/controls/OrbitControls.js'

// Init
const scene = new THREE.Scene();
let camera = new THREE.PerspectiveCamera(130, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.z = 30;
const renderer = new THREE.WebGLRenderer({
    canvas: document.getElementById("bg")
}); 
let controls = new OrbitControls(camera, renderer.domElement);

if(DEVEL){

}
else{
    document.getElementById("fps").style.display = "none";
}

function initCamera(){
    let position = camera.position;
    //let rotation = camera.rotation;
    camera = new THREE.PerspectiveCamera(130, window.innerWidth / window.innerHeight, 0.1, 1000);
    renderer.setPixelRatio( window.devicePixelRatio );
    renderer.setSize(window.innerWidth, window.innerHeight);
    controls = new OrbitControls(camera, renderer.domElement);
    camera.position.x = position.x;
    camera.position.y = position.y;
    camera.position.z = position.z;
}
initCamera();
window.onresize = initCamera;

// Main Devel Scene
const gridHelper = new THREE.GridHelper(200, 50);
const axisHelper = new THREE.AxesHelper(15);

const geomerty = new THREE.TorusGeometry(10, 3, 16, 100);
const material = new THREE.MeshBasicMaterial( {color: 0xFF6347, wireframe: true});
const torus = new THREE.Mesh(geomerty, material);

function loadScene(){
    scene.add(torus);
    if(DEVEL){
        scene.add(gridHelper, axisHelper);
    }
}
loadScene();

let animationTimeStamp = new Date().getTime();
function animate(){
    requestAnimationFrame(animate);

    
    // Update code goes here:
    let now = new Date().getTime();
    let dt = now - animationTimeStamp;
    animationTimeStamp = now;

    torus.rotation.x += dt*0.001;
    torus.rotation.y += dt*0.0005;
    torus.rotation.z += dt*0.001;

    controls.update();
    renderer.render(scene, camera);

    if(DEVEL){
        document.getElementById("fps").innerHTML = "fps: "+(1000/dt);
    }

}
animate();