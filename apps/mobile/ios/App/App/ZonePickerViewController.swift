import MapKit
import UIKit

/// Carte native pour poser une zone (LOKKAL-PHONE §5, écran 6) : le centre est sous l'épingle fixe au milieu, le cercle
/// montre le rayon (150 m à 2 km). Rien ne quitte l'appareil ici : le résultat revient à l'interface, qui le garde sur
/// l'appareil (NokkerZones.setZones) et n'envoie au noyau que le nom et l'id.
final class ZonePickerViewController: UIViewController, MKMapViewDelegate {
    struct Result { let lat: Double; let lon: Double; let radius: Double }

    private let map = MKMapView()
    private let slider = UISlider()
    private let radiusLabel = UILabel()
    private var circle: MKCircle?
    private var radius: Double
    private let initialCenter: CLLocationCoordinate2D?
    private let labels: (ok: String, cancel: String, radius: String)
    private let done: (Result?) -> Void
    private var answered = false

    init(title: String, radius: Double, center: CLLocationCoordinate2D?, labels: (String, String, String), done: @escaping (Result?) -> Void) {
        self.radius = radius
        self.initialCenter = center
        self.labels = (labels.0, labels.1, labels.2)
        self.done = done
        super.init(nibName: nil, bundle: nil)
        self.title = title
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) unused") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: labels.cancel, style: .plain, target: self, action: #selector(cancel))
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: labels.ok, style: .done, target: self, action: #selector(confirm))

        map.delegate = self
        map.showsUserLocation = true
        map.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(map)

        let pin = UIImageView(image: UIImage(systemName: "mappin"))
        pin.tintColor = .systemRed
        pin.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(pin)

        slider.minimumValue = 150
        slider.maximumValue = 2000
        slider.value = Float(radius)
        slider.addTarget(self, action: #selector(radiusChanged), for: .valueChanged)
        radiusLabel.font = .preferredFont(forTextStyle: .body)
        radiusLabel.adjustsFontForContentSizeCategory = true
        let bar = UIStackView(arrangedSubviews: [radiusLabel, slider])
        bar.axis = .vertical
        bar.spacing = 8
        bar.isLayoutMarginsRelativeArrangement = true
        bar.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 12, leading: 20, bottom: 12, trailing: 20)
        bar.backgroundColor = .secondarySystemBackground
        bar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(bar)

        NSLayoutConstraint.activate([
            map.topAnchor.constraint(equalTo: view.topAnchor),
            map.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            map.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            map.bottomAnchor.constraint(equalTo: bar.topAnchor),
            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bar.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            pin.centerXAnchor.constraint(equalTo: map.centerXAnchor),
            pin.bottomAnchor.constraint(equalTo: map.centerYAnchor),
            slider.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
        ])

        let center = initialCenter ?? CLLocationCoordinate2D(latitude: 46.2044, longitude: 6.1432)
        map.setRegion(MKCoordinateRegion(center: center, latitudinalMeters: radius * 5, longitudinalMeters: radius * 5), animated: false)
        updateCircle()
    }

    func mapView(_ mapView: MKMapView, didUpdate userLocation: MKUserLocation) {
        // Sans centre donné : la première position connue de l'appareil, une seule fois.
        if initialCenter == nil, userLocation.location != nil, !movedToUser {
            movedToUser = true
            map.setCenter(userLocation.coordinate, animated: true)
        }
    }
    private var movedToUser = false

    func mapView(_ mapView: MKMapView, regionDidChangeAnimated animated: Bool) { updateCircle() }

    func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
        let r = MKCircleRenderer(overlay: overlay)
        r.fillColor = UIColor.systemRed.withAlphaComponent(0.12)
        r.strokeColor = .systemRed
        r.lineWidth = 2
        return r
    }

    private func updateCircle() {
        if let c = circle { map.removeOverlay(c) }
        let c = MKCircle(center: map.centerCoordinate, radius: radius)
        map.addOverlay(c)
        circle = c
        radiusLabel.text = labels.radius.replacingOccurrences(of: "%d", with: String(Int(radius.rounded())))
    }

    @objc private func radiusChanged() {
        radius = (Double(slider.value) / 10).rounded() * 10
        updateCircle()
    }

    @objc private func cancel() { finish(nil) }
    @objc private func confirm() {
        let c = map.centerCoordinate
        finish(Result(lat: c.latitude, lon: c.longitude, radius: radius))
    }

    private func finish(_ r: Result?) {
        guard !answered else { return }
        answered = true
        dismiss(animated: true) { self.done(r) }
    }
}
