// Array of image URLs to be loaded
// const imageUrls = ['image1.jpg', 'image2.jpg', 'image3.jpg']; // Add your image URLs here

class UI{
    constructor(CSSPath){
        this.CSSPath = CSSPath;
        this.initTime = new Date().getTime();
        this.progress = 0;
        this.loadQuotes = [
            "What yo need to do is ...",
            "Have you found the lost høydemeters of vollabakken!?",
            "Sometimes all you need to do is to find a big rock in the woods, where you can sit down and ponder"
        ];
        this.loadScreen = null;
    }
    ///////////////////
    //      Init     //
    ///////////////////
    init(){
        if(!this.isCssLoaded(this.CSSPath)) {
            console.error("Can not initialize UI elements from that CSS path");
        }
        let loadScreen = document.createElement("div");
        loadScreen.id = "loadScreen";

    }
    isCssLoaded(cssFileUrl) {
        for (let i = 0; i < document.styleSheets.length; i++) {
            const styleSheet = document.styleSheets[i];
            if (styleSheet.href === cssFileUrl) {
                return true;
            }
        }
        return false;
    }

    ///////////////////
    //  Load screen  //
    ///////////////////
    load(imageUrls){
        if(imageUrls.length == 0){
            this.onAllImagesLoaded();
        }
        this.preloadImages(imageUrls);
        // add future stuff when needed
    }    
    
    preloadImages(urls) {
        let loadedImages = 0;
    
        urls.forEach(url => {
            const img = new Image();
            img.onload = () => {
                loadedImages++;
                this.progressCallback(loadedImages, urls.length);
    
                // Check if all images are loaded
                if (loadedImages === urls.length) {
                    this.completionCallback();
                }
            };
            img.src = url;
        });
    }    
    updateProgress(loadedImages, totalImages) {
        this.progress = (loadedImages / totalImages) * 100;
        //console.log(`Loading: ${progress.toFixed(2)}%`);
    }    
    onAllImagesLoaded() {
        // console.log('All images are loaded!');
        // TODO close load screen
    }



}
