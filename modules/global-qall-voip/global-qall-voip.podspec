require 'json'
package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'GlobalQallVoip'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = { :type => 'MIT' }
  s.author         = { 'Global Qall' => 'gseremba@gmail.com' }
  s.homepage       = 'https://globalqall.com'
  s.platforms      = { :ios => '13.0' }
  s.swift_version  = '5.9'
  s.source         = { :git => 'https://example.invalid/global-qall-voip.git', :tag => s.version.to_s }
  s.static_framework = true

  s.source_files = 'ios/**/*.{h,m,mm,swift}'
  s.frameworks = 'PushKit', 'CallKit'

  s.dependency 'ExpoModulesCore'
  s.dependency 'RNCallKeep'
  s.dependency 'RNVoipPushNotification'
end
