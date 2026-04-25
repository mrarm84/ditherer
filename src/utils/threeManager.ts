import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export interface GlbConfig {
  autoRotateSpeed: number;
  allowMouseMoving: boolean;
}

class ThreeManager {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private canvas: HTMLCanvasElement;
  private model: THREE.Group | null = null;
  private controls: OrbitControls;
  private config: GlbConfig = { autoRotateSpeed: 0, allowMouseMoving: true };

  constructor(width = 800, height = 600) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x222222);

    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    this.camera.position.set(0, 1, 5);

    this.canvas = document.createElement("canvas");
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(1);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(5, 5, 5);
    this.scene.add(directionalLight);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
  }

  public setSize(width: number, height: number) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  public async loadGlb(url: string): Promise<void> {
    const loader = new GLTFLoader();
    return new Promise((resolve, reject) => {
      loader.load(
        url,
        (gltf) => {
          if (this.model) this.scene.remove(this.model);
          this.model = gltf.scene;
          
          // Center and scale model
          const box = new THREE.Box3().setFromObject(this.model);
          const center = box.getCenter(new THREE.Vector3());
          const size = box.getSize(new THREE.Vector3());
          const maxDim = Math.max(size.x, size.y, size.z);
          const scale = 3 / maxDim;
          this.model.scale.set(scale, scale, scale);
          this.model.position.sub(center.multiplyScalar(scale));
          
          this.scene.add(this.model);
          resolve();
        },
        undefined,
        reject
      );
    });
  }

  public setConfig(config: Partial<GlbConfig>) {
    this.config = { ...this.config, ...config };
    this.controls.enabled = this.config.allowMouseMoving;
  }

  public update(deltaTime: number) {
    if (this.model && this.config.autoRotateSpeed !== 0) {
      this.model.rotation.y += this.config.autoRotateSpeed * deltaTime;
    }
    if (this.config.allowMouseMoving) {
      this.controls.update();
    }
  }

  public render(): HTMLCanvasElement {
    this.renderer.render(this.scene, this.camera);
    return this.canvas;
  }

  public getCanvas() {
    return this.canvas;
  }
}

export const threeManager = new ThreeManager();
